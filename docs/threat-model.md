# Threat Model

Security model for a self-hosted Flakemetry instance. Scope: the ingestion API, the dashboard, the processing worker, Postgres, and the object store. Companion to [Architecture](https://github.com/AKogut/flakemetry/blob/main/docs/architecture.md) and [Configuration](https://github.com/AKogut/flakemetry/blob/main/docs/configuration.md).

## Assets

- **Test intelligence data** — runs, executions, error signatures, flaky scores, RCA reports. Tenant-scoped; disclosure across tenants is the primary confidentiality concern.
- **Ingest tokens** — per-project bearer secrets. Stored only as SHA-256 hashes; the raw value is shown once at creation.
- **User sessions** — Auth.js database sessions behind OAuth.
- **Artifacts** — screenshots, video, traces, HAR files in the object store, addressed by tenant-scoped keys and served via short-lived signed URLs.
- **LLM budget** — per-project daily token cap; abuse is a cost/DoS concern.

## Trust boundaries

1. **CI → Ingestion API.** Untrusted payloads authenticated by an ingest token. The boundary that receives the most attacker-controllable input (error messages, stacks, file paths, CODEOWNERS, notification routing).
2. **Browser → Dashboard.** User-authenticated (OAuth + database sessions), role-gated per membership.
3. **API/Worker → Postgres / object store.** Trusted internal services; every query is tenant-scoped by `orgId` + `projectId`.
4. **Worker → external webhooks / SMTP / LLM.** Outbound to third parties on operator-supplied or config-supplied targets.

## STRIDE

| Category | Threat | Mitigation |
|---|---|---|
| **Spoofing** | Forged ingest requests | Bearer token, looked up by SHA-256 hash (no plaintext compare); unknown/revoked tokens rejected. Dashboard requires an authenticated session. |
| **Tampering** | Cross-tenant writes; malicious payloads | Every read/write is scoped by `orgId` + `projectId`; ingest is validated against zod contracts before enqueue. Migrations are additive. |
| **Repudiation** | Untraceable policy changes; an export or deletion nobody can account for | Policy changes are recorded with actor and timestamp; the `authorization` header is redacted in logs. Every export and every erasure writes an audit row naming the actor, which deliberately has no foreign key to the tenant so a deletion cannot take its own record with it. |
| **Information disclosure** | Reading another tenant's data or artifacts | Tenant scoping on all queries; artifact keys are tenant-prefixed and served only through short-lived signed URLs. Auth cookies are `httpOnly` + `secure` (prod) + `sameSite`. |
| **Denial of service** | Request floods, oversized/compressed bodies, ReDoS, alert/LLM abuse | Per-token fixed-window rate limiting with `Retry-After`; queue-depth backpressure (`503`); an 8 MB body limit that also bounds the decompressed gzip stream, plus an explicit 16 MB decompression ceiling as defense-in-depth; the CODEOWNERS glob compiler collapses adjacent wildcards and caps pattern length/count; the notification dedupe window and per-project daily LLM token cap bound outbound cost. |
| **Elevation of privilege** | A viewer changing settings; a read credential becoming a write one | Owner/admin role checks on token, policy, and notification management; tenant deletion is owner-only and needs the slug typed, checked server-side. The bulk export omits ingest token hashes, webhook signing secrets and the badge token, so a `read` credential cannot be turned into one that writes. |

## Attacker-controllable input, and how it is contained

- **Error messages / stacks** — scrubbed before storage; rendered as data, never evaluated. RCA prompts treat them as untrusted content.
- **File paths / titles** — flow into the PR-gate comment, which escapes backticks/pipes/newlines; the base-branch ref is charset-validated at the route.
- **CODEOWNERS** — compiled with a wildcard-collapsing, length/-count-capped matcher (no catastrophic backtracking).
- **Notification targets** — webhook URLs must be https and are blocked from loopback/private/link-local/metadata ranges; email targets are format-validated; outbound webhook calls carry a timeout.

## Transport hardening

- **API** responds with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, and HSTS in production.
- **Dashboard** sets a Content-Security-Policy (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`), `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS in production.

## Residual risks / follow-ups

- The dashboard CSP still allows `'unsafe-inline'` scripts; a nonce-based strict CSP is a follow-up.
- SSRF protection blocks address literals but does not defend against DNS-rebinding of a webhook host; resolve-and-pin is a follow-up.
- No formal RBAC/SSO beyond owner/admin/member roles (tracked in #49).
- Load/soak testing and ingestion SLOs (#71) and backup/restore (#72) are tracked separately.
