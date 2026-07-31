# Deploying Flakemetry

`docker compose up` (see the root README) is the path for local and small self-hosted use.
This directory is the path for a **hosted, horizontally scaled** environment: a Helm chart
for Kubernetes plus an operations runbook.

- [`helm/flakemetry`](helm/flakemetry) — the chart (api, worker, web, migrations, HPAs, ingress).
- [`helm/example-values.yaml`](helm/example-values.yaml) — a documented production values file.
- [`RUNBOOK.md`](RUNBOOK.md) — SLOs, scaling, upgrade/rollback, and symptom→action runbook.

## From zero to a running environment

Flakemetry needs a managed **Postgres** and an S3-compatible **object store**. The chart
never bundles a database — production uses your managed services. The queue is a Postgres
table, so there is no separate broker.

### 1. Provision dependencies

- A Postgres 16 database (with the `pgvector` extension for AI RCA).
- An S3 bucket (or compatible) plus access credentials.

### 2. Publish the images

The chart references four images (`flakemetry-api`, `flakemetry-worker`, `flakemetry-web`,
`flakemetry-migrate`), built from the repository [`Dockerfile`](../Dockerfile) targets. Build
and push them to your registry, then set `image.registry` / `image.repository` / `image.tag`.

```bash
for target in api worker web migrate; do
  docker build --target "$target" -t ghcr.io/akogut/flakemetry-$target:v0.1.0 .
  docker push ghcr.io/akogut/flakemetry-$target:v0.1.0
done
```

### 3. Configure values

Copy [`helm/example-values.yaml`](helm/example-values.yaml) and fill in the database URL,
object-store credentials, `auth.secret` (`openssl rand -base64 32`), GitHub OAuth app, and
your hostnames. Inject secrets from your secret manager, or point `existingSecret` at a
pre-created Kubernetes Secret with the expected keys and set nothing sensitive in values.

### 4. Install

```bash
helm upgrade --install flakemetry deploy/helm/flakemetry \
  -n flakemetry --create-namespace \
  -f my-values.yaml
```

Migrations run automatically as a pre-install hook before the app pods start. When the
release is ready, the dashboard is on your `ingress.web.host` and the ingest API on
`ingress.api.host`. Create a project and its ingest token in the dashboard, point your
reporters at the ingest host, and runs start flowing.

## What scales, and how

`api` and `worker` are stateless and ship with CPU-target HorizontalPodAutoscalers, so
ingestion and processing scale independently with load. The durable Postgres queue lets the
worker fleet lag under a spike and catch up without dropping data. See
[`RUNBOOK.md`](RUNBOOK.md) for scaling guidance and SLOs.

## Not yet here

Terraform modules for the managed dependencies and reference OTel dashboards for the
platform's own telemetry are tracked as a follow-up on the
[roadmap](https://github.com/users/AKogut/projects/14). Today the documented path is the
Helm chart against managed Postgres and object storage.
