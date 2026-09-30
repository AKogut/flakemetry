\set ON_ERROR_STOP on

SELECT set_config('bench.tests', :'tests', false),
       set_config('bench.runs_per_day', :'runs_per_day', false),
       set_config('bench.days', :'days', false);

INSERT INTO org (id, name, slug)
VALUES ('00000000-0000-4000-8000-000000000001', 'Bench', 'bench');

INSERT INTO project (id, org_id, name, slug, codeowners)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'Web',
  'web',
  E'tests/area-1*/ @acme/checkout\ntests/area-2*/ @acme/identity\n* @acme/qa'
);

CREATE TEMP TABLE bench_identity AS
SELECT i,
       gen_random_uuid() AS id,
       i % 20 = 0 AS flaky
FROM generate_series(1, :tests) AS i;

INSERT INTO test_identity (id, org_id, project_id, fingerprint, file_path, suite, title, aliases, first_seen_at, last_seen_at)
SELECT id,
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       'fp-' || i,
       'tests/area-' || (i % 50) || '/spec-' || (i % 400) || '.spec.ts',
       'suite-' || (i % 40),
       'behaves correctly in case ' || i,
       '{}',
       now() - make_interval(days => :days),
       now()
FROM bench_identity;

CREATE TEMP TABLE bench_signature AS
SELECT s, gen_random_uuid() AS id FROM generate_series(0, 49) AS s;

INSERT INTO error_signature (id, org_id, project_id, normalized_hash, sample_message, stack_template, occurrence_count)
SELECT id,
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       md5('signature-' || s),
       'Timeout 5000ms exceeded waiting for locator #item-' || s,
       'at Page.click (tests/area-' || s || '/spec.spec.ts:10:5)',
       1000
FROM bench_signature;

CREATE TEMP TABLE bench_run AS
SELECT d,
       r,
       gen_random_uuid() AS id,
       date_trunc('day', now()) - make_interval(days => :days - 1 - d)
         + make_interval(mins => (r * 1440 / :runs_per_day)) AS started_at,
       CASE WHEN r % 5 = 0 THEN 'feature-' || (r % 17) ELSE 'main' END AS branch
FROM generate_series(0, :days - 1) AS d,
     generate_series(0, :runs_per_day - 1) AS r;

INSERT INTO run (id, org_id, project_id, idempotency_key, commit_sha, branch, ci_provider, trigger, status, started_at, finished_at, duration_ms)
SELECT id,
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       'bench-' || d || '-' || r,
       md5('commit-' || d || '-' || r) || substr(md5('sha-' || d || '-' || r), 1, 8),
       branch,
       'github_actions',
       CASE WHEN branch = 'main' THEN 'push'::"RunTrigger" ELSE 'pull_request'::"RunTrigger" END,
       'passed',
       started_at,
       started_at + interval '6 minutes',
       360000
FROM bench_run;

INSERT INTO test_execution (id, org_id, project_id, run_id, test_identity_id, ordinal, attempt, status, duration_ms, error_message, error_signature_id, otel_trace_id, otel_span_id, spans, started_at)
SELECT gen_random_uuid(),
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       run.id,
       identity.id,
       identity.i,
       1,
       outcome.status,
       100 + (hashtext(run.id::text || identity.i) & 4095),
       CASE WHEN outcome.status = 'fail' THEN 'Timeout 5000ms exceeded waiting for locator' END,
       CASE WHEN outcome.status = 'fail' THEN (SELECT id FROM bench_signature WHERE s = identity.i % 50) END,
       CASE WHEN identity.i % 10 = 0 THEN md5(run.id::text) END,
       CASE WHEN identity.i % 10 = 0 THEN substr(md5(run.id::text || identity.i), 1, 16) END,
       CASE WHEN identity.i % 10 = 0 THEN jsonb_build_array(
         jsonb_build_object('spanId', substr(md5(identity.i || 'a'), 1, 16), 'name', 'goto /checkout', 'kind', 'step', 'status', 'ok', 'durationMs', 420),
         jsonb_build_object('spanId', substr(md5(identity.i || 'b'), 1, 16), 'name', 'POST /api/cart', 'kind', 'http', 'status', 'ok', 'durationMs', 85),
         jsonb_build_object('spanId', substr(md5(identity.i || 'c'), 1, 16), 'name', 'expect visible', 'kind', 'step', 'status', 'ok', 'durationMs', 12)
       ) END,
       run.started_at + make_interval(secs => identity.i * 0.1)
FROM bench_run AS run
CROSS JOIN bench_identity AS identity
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN identity.flaky AND (hashtext(run.id::text || identity.i) & 1023) < 200 THEN 'fail'::"TestStatus"
    WHEN (hashtext(run.id::text || identity.i) & 1023) < 5 THEN 'fail'::"TestStatus"
    WHEN identity.i % 50 = 7 THEN 'skip'::"TestStatus"
    ELSE 'pass'::"TestStatus"
  END AS status
) AS outcome;

INSERT INTO test_execution (id, org_id, project_id, run_id, test_identity_id, attempt, retry_of, status, duration_ms, started_at)
SELECT gen_random_uuid(), org_id, project_id, run_id, test_identity_id, 2, id, 'pass', duration_ms, started_at + interval '10 seconds'
FROM test_execution
WHERE status = 'fail' AND attempt = 1;

INSERT INTO flaky_score (test_identity_id, org_id, project_id, score, flip_rate, pass_on_rerun_rate, same_sha_variance, entropy, fail_isolation, reason_codes, quarantine_candidate, last_flaked_at, model_version, updated_at)
SELECT id,
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       CASE WHEN flaky THEN 0.3 + (i % 7) * 0.1 ELSE 0.01 END,
       CASE WHEN flaky THEN 0.3 ELSE 0 END,
       CASE WHEN flaky THEN 0.2 ELSE 0 END,
       CASE WHEN flaky THEN 0.1 ELSE 0 END,
       CASE WHEN flaky THEN 0.5 ELSE 0 END,
       1,
       CASE WHEN flaky THEN '[{"code":"PASSED_ON_RERUN","weight":0.4}]'::jsonb ELSE '[]'::jsonb END,
       flaky AND i % 3 = 0,
       CASE WHEN flaky THEN now() - interval '1 day' END,
       'bench',
       now()
FROM bench_identity;

INSERT INTO test_health_event (id, org_id, project_id, test_identity_id, kind, score, created_at)
SELECT gen_random_uuid(),
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       id,
       event.kind,
       0.5,
       now() - make_interval(days => event.days_ago)
FROM bench_identity
CROSS JOIN (VALUES ('flaked', 20), ('stabilized', 12), ('flaked', 5)) AS event(kind, days_ago)
WHERE flaky;

INSERT INTO daily_test_stats (project_id, org_id, test_identity_id, day, total, passed, failed, flaky, skipped, avg_duration_ms, rerun_count, rerun_ms, updated_at)
SELECT project_id, org_id, test_identity_id, started_at::date,
       count(*) FILTER (WHERE attempt = 1),
       count(*) FILTER (WHERE status = 'pass' AND attempt = 1),
       count(*) FILTER (WHERE status = 'fail' AND attempt = 1),
       count(*) FILTER (WHERE status = 'fail' AND attempt = 1),
       count(*) FILTER (WHERE status = 'skip'),
       avg(duration_ms)::int,
       count(*) FILTER (WHERE attempt > 1),
       coalesce(sum(duration_ms) FILTER (WHERE attempt > 1), 0),
       now()
FROM test_execution
GROUP BY project_id, org_id, test_identity_id, started_at::date;

INSERT INTO suite_daily (project_id, org_id, suite, day, total, passed, failed, flaky, skipped, avg_duration_ms, rerun_count, rerun_ms, updated_at)
SELECT s.project_id, s.org_id, i.suite, s.day, sum(s.total), sum(s.passed), sum(s.failed), sum(s.flaky), sum(s.skipped), avg(s.avg_duration_ms)::int, sum(s.rerun_count), sum(s.rerun_ms), now()
FROM daily_test_stats s
JOIN test_identity i ON i.id = s.test_identity_id
GROUP BY s.project_id, s.org_id, i.suite, s.day;

INSERT INTO flaky_trends (project_id, org_id, day, flaky_count, quarantined_count, avg_score, updated_at)
SELECT '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', day, :tests / 20, :tests / 60, 0.55, now()
FROM generate_series(current_date - (:days - 1), current_date, interval '1 day') AS day;

VACUUM ANALYZE;

SELECT (SELECT count(*) FROM test_execution) AS executions,
       (SELECT count(*) FROM run) AS runs,
       (SELECT count(*) FROM test_identity) AS identities,
       pg_size_pretty(pg_total_relation_size('test_execution')) AS execution_table;
