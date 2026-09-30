# Self-hosting

Flakemetry self-hosts with a single `docker compose up`. The compose stack runs the
ingestion API, worker, dashboard, PostgreSQL, and a MinIO object store for artifacts.

## Prerequisites

- Docker with Compose v2
- A GitHub OAuth app for dashboard sign-in (below)

## Bring the stack up

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
cp .env.example .env
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up
```

The dashboard is on [localhost:3000](http://localhost:3000) and the ingestion API on
[localhost:4000](http://localhost:4000), seeded with demo runs.

The demo dataset is only written when the database is empty, so restarting the stack keeps
everything you have ingested. Use `pnpm demo` when you do want a clean slate.

## GitHub sign-in

Sign-in uses GitHub OAuth. Create an OAuth app with callback
`http://localhost:3000/api/auth/callback/github`, then set `AUTH_GITHUB_ID` and
`AUTH_GITHUB_SECRET` in `.env`. The first account to sign in adopts the seeded workspace.

## See it in 60 seconds

Load the demo dataset — one project's worth of history with a stable test, two flaky
tests, and a regression that AI RCA explains:

```bash
pnpm demo   # resets the database and seeds the demo dataset in one command
```

Then walk the story in the dashboard:

1. **Flaky board** — every test ranked by a transparent score, worst first.
2. **Test detail** — that score broken into reason codes (same commit different result ·
   pass-on-rerun · …).
3. **RCA panel** — the `orders` regression, explained with a likely cause and a suggested
   fix.

## Configuration

Every knob — artifact storage, retention, scoring policy, AI provider — is an environment
variable. See the [Configuration reference](/reference/configuration) for the complete
list, and the [Threat model](/reference/threat-model) for the transport and token
hardening story.

## Production deployment

### One host

The compose stack above is the quickstart: it publishes ports and ships development
passwords, and its ports bind to loopback for that reason — Docker publishes straight past
the host firewall, so on a machine with a public address the quickstart would put Postgres
on the internet.

[`deploy/compose`](https://github.com/AKogut/flakemetry/tree/main/deploy/compose) is the
version you point a domain at: Caddy terminating TLS with automatic certificates, nothing
published but the proxy, and a refusal to start when a secret is missing rather than a
fallback to the development password. Its
[README](https://github.com/AKogut/flakemetry/blob/main/deploy/compose/README.md) covers DNS,
the OAuth app, backups, and why the object store needs a public hostname even for traffic
that never leaves the machine.

### Many hosts

For a horizontally scaled hosted environment there is a **Helm chart** in
[`deploy/helm/flakemetry`](https://github.com/AKogut/flakemetry/tree/main/deploy/helm/flakemetry):
stateless `api`/`worker`/`web` with HorizontalPodAutoscalers, a pre-install migration hook,
and ingress — running against a managed Postgres and object store. The
[deploy guide](https://github.com/AKogut/flakemetry/blob/main/deploy/README.md) walks the
path from zero to a running environment, and the
[runbook](https://github.com/AKogut/flakemetry/blob/main/deploy/RUNBOOK.md) covers SLOs,
scaling, and upgrades.

On AWS, the [Terraform module](https://github.com/AKogut/flakemetry/tree/main/deploy/terraform/aws)
provisions the managed pieces the chart expects:

- PostgreSQL 16 on RDS, private and encrypted, reachable only from the security groups you
  name;
- an artifact bucket that is private, encrypted and TLS-only;
- S3 access through an IAM role for the release's service account, or an access key.

It writes the chart values that connect them. That includes the RDS certificate authority
as `database.caBundle`, so the pods verify the database's certificate rather than just
encrypting to it.

### Watching Flakemetry itself

The api and worker report their own health as OpenTelemetry metrics: ingest latency and
errors, how long runs wait and take to process, queue depth, and worker failures. Locally:

```bash
FLAKEMETRY_SELF_OTEL_ENDPOINT=http://otel-collector:4318 \
  docker compose --profile observability up -d
```

adds an OpenTelemetry Collector, Prometheus with the SLO alert rules, and Grafana on
`http://localhost:3001` with the **Flakemetry platform** dashboard. Grafana's own default
sign-in, `admin`/`admin`, asks for a new password the first time.

In production, point `FLAKEMETRY_SELF_OTEL_ENDPOINT` (the chart's
`selfTelemetry.otlpEndpoint`) at your collector, and load the rules and the dashboard from
[`deploy/observability`](https://github.com/AKogut/flakemetry/tree/main/deploy/observability)
into your own Prometheus and Grafana.
