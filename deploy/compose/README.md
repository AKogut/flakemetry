# Single-host deployment

One VPS, TLS included, nothing exposed but the proxy. This is the smallest thing that is
honestly a deployment rather than a demo.

The repository root's `docker-compose.yml` is the quickstart — it publishes ports and ships
development passwords. Use this directory when a domain points at the machine.

## What you need first

- **A VPS.** 2 vCPU / 4 GB is a comfortable start: Postgres, three Node services, MinIO and
  Caddy. Disk follows retention — a suite of a few thousand executions a day fits in tens of
  gigabytes at 90-day retention, and artifacts dominate if you keep video.
- **Three DNS A records**, all pointing at the machine, all resolving *before* you start.
  Caddy orders certificates on first boot and a record that is not live yet fails the order.

  | Name | Serves |
  | --- | --- |
  | `flakemetry.example.com` | the dashboard |
  | `api.flakemetry.example.com` | ingestion and the read API — this is `FLAKEMETRY_ENDPOINT` |
  | `artifacts.flakemetry.example.com` | the object store |

  Three names rather than one with path routing because the dashboard and the API both answer
  on `/health`, and `flakemetry doctor` probes exactly that to tell an unreachable endpoint
  from a rejected token.

- **A GitHub OAuth app** (Settings → Developer settings → OAuth Apps):
  - Homepage `https://flakemetry.example.com`
  - Callback `https://flakemetry.example.com/api/auth/callback/github`

## Bring it up

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
cp deploy/compose/.env.example deploy/compose/.env
$EDITOR deploy/compose/.env          # nothing has a working default, by design

docker compose -f deploy/compose/docker-compose.yml \
  --env-file deploy/compose/.env up -d --build
```

The stack refuses to start with a secret missing rather than falling back to the
quickstart's password:

```
required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD
```

Check it:

```bash
curl -sf https://api.flakemetry.example.com/health     # {"status":"ok","service":"api"}
```

Then open the dashboard and sign in with GitHub. **The first account to sign in becomes the
owner** — do this yourself, immediately, before the host is discoverable.

## Your first project and token

In the dashboard:

1. Name the workspace and the project. The slug is derived from the project name:
   lowercased, every non-alphanumeric run becomes `-`, trimmed, capped at 48 characters.
   Typing `playwright-ecommerce-framework` gives exactly that slug.
2. **Settings → Ingest tokens → Create**, with the **`ingest`** scope only. Copy it now; only
   a hash is stored, so it cannot be shown again.
3. **Settings → Policy** — set the repository to `owner/name` if you want tracker issues, and
   confirm the retention windows.

Add a second token with the **`read`** scope only if something needs to query the API. Keep
them separate: a credential in CI that can also read is a credential that leaks more when it
leaks.

## Wiring a repository

Two secrets on the repository: `FLAKEMETRY_ENDPOINT` (`https://api.flakemetry.example.com`)
and `FLAKEMETRY_TOKEN`.

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4, 5, 6, 7]
    steps:
      - uses: actions/checkout@v4
      # …setup…
      - name: Run tests
        run: npx playwright test --shard=${{ matrix.shard }}/7
        env:
          FLAKEMETRY_OUTPUT_FILE: flakemetry-results.json

      - name: Upload to Flakemetry
        if: always()
        uses: AKogut/flakemetry/.github/actions/flakemetry@main
        with:
          token: ${{ secrets.FLAKEMETRY_TOKEN }}
          endpoint: ${{ secrets.FLAKEMETRY_ENDPOINT }}
```

`if: always()` matters: results are most worth having when the suite failed. The upload never
fails the job.

Each shard lands as its own run, correlated by CI run id — the shard index and total are
detected from the environment, not configured.

### Rate limits

600 requests per minute per project. A run costs roughly two requests per job — one ingest,
one presign for *all* of that job's artifacts, since artifact bodies go straight to object
storage and never touch the API — plus up to ten polls if you use the PR-comment action.
Seven shards is around thirty requests: about five per cent of the window.

The counter lives in each API process's memory, so with more than one API replica the real
ceiling is 600 × replicas and is not shared. On a single host the number is exact. It is not
configurable from the environment.

## Operations

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env logs -f worker
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env pull
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d --build
```

Migrations run as a one-shot `migrate` service before the apps start, and are additive, so an
upgrade is a rebuild.

**Back up Postgres.** It is the system of record — history, identities, scores, the queue.
Artifacts are regenerable; the database is not.

```bash
FLAKEMETRY_COMPOSE="docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env" \
  sh deploy/backup/backup.sh /var/backups/flakemetry
```

Put it on a timer and **ship the result off the box** — a backup on the machine that dies
is not one. Nothing in this stack copies it for you.

Restoring is `deploy/backup/restore.sh <dump>` followed by `deploy/backup/verify.sh`, and
the whole path is drilled in CI on every change: it destroys the database volume and brings
the instance back from a dump. See the [runbook](../RUNBOOK.md#backups--disaster-recovery)
for RPO/RTO and the reasoning.

## Verified, and what that covers

This stack has been run end to end — not only `docker compose config`:

| | |
| --- | --- |
| Only Caddy publishes | 80 and 443; Postgres and MinIO are reachable only inside the network |
| Both apps answer `/health` | `{"service":"api"}` and `{"service":"web"}` on their own hostnames, which is why they are separate hostnames |
| Artifacts round-trip | presign → `PUT` → presigned `GET` returns the same bytes |
| The object store refuses unsigned requests | `403 AccessDenied` on a plain `GET` |

**A presigned upload is bound to the size it was issued for.** A body larger than the
declared `sizeBytes` is refused with `403`, so a grant for a screenshot cannot be spent on a
gigabyte. Worth knowing before you read a `403` as a misconfiguration.

The one thing local testing cannot cover is certificate issuance: Caddy uses an internal
certificate for a `.localhost` name and only talks to Let's Encrypt for a real domain. Point
the DNS records at the host before the first start, or the initial order fails.

If you move to real S3 or R2, set `FLAKEMETRY_S3_ENDPOINT` to the hostname your CI runners
and browsers actually connect to. SigV4 signs the `Host` header, so a URL signed for
`minio:9000` is rejected the moment a browser presents the public name — which is why every
service here signs against the public artifact host even for traffic that never leaves the
machine.
