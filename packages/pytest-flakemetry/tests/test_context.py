from __future__ import annotations

from pytest_flakemetry.context import build_idempotency_key, resolve_run_context

GITHUB = {
    "GITHUB_ACTIONS": "true",
    "GITHUB_SHA": "abc1234def",
    "GITHUB_REF_NAME": "feature/login",
    "GITHUB_RUN_ID": "555",
    "GITHUB_EVENT_NAME": "pull_request",
    "GITHUB_REF": "refs/pull/42/merge",
}


def test_reads_github_actions_context() -> None:
    context = resolve_run_context(GITHUB)

    assert context.ci_provider == "github_actions"
    assert context.trigger == "pull_request"
    assert context.commit_sha == "abc1234def"
    assert context.branch == "feature/login"
    assert context.pr_number == 42
    assert context.to_resource()["ciRunId"] == "555"


def test_falls_back_to_local_defaults_off_ci() -> None:
    context = resolve_run_context({})

    assert context.ci_provider == "local"
    assert context.trigger == "manual"
    assert context.branch == "local"
    # The contract requires a 7-40 character commit sha, so the fallback is padded.
    assert len(context.commit_sha) >= 7
    assert "prNumber" not in context.to_resource()


def test_explicit_overrides_win_over_defaults() -> None:
    context = resolve_run_context(
        {"FLAKEMETRY_COMMIT_SHA": "deadbeef", "FLAKEMETRY_BRANCH": "release"}
    )

    assert context.commit_sha == "deadbeef"
    assert context.branch == "release"


def test_idempotency_key_is_stable_per_ci_run_and_long_enough() -> None:
    context = resolve_run_context(GITHUB)
    key = build_idempotency_key(context, {**GITHUB, "GITHUB_RUN_ATTEMPT": "2"})

    assert key == "github_actions-555-2"
    assert build_idempotency_key(context, GITHUB) == "github_actions-555-1"

    explicit = build_idempotency_key(context, {"FLAKEMETRY_IDEMPOTENCY_KEY": "chosen-by-hand"})
    assert explicit == "chosen-by-hand"

    # Off CI there is no run id, but the key must still satisfy the contract minimum.
    local = resolve_run_context({})
    assert len(build_idempotency_key(local, {})) >= 8


def test_shards_get_distinct_keys() -> None:
    context = resolve_run_context(GITHUB)
    first = build_idempotency_key(context, {**GITHUB, "FLAKEMETRY_SHARD_INDEX": "1"})
    second = build_idempotency_key(context, {**GITHUB, "FLAKEMETRY_SHARD_INDEX": "2"})

    assert first != second
