# Data governance

Flakemetry holds test data on your behalf: runs, executions, error messages, screenshots.
This page covers the three things a data-protection agreement asks for — getting it out,
knowing how long it stays, and getting rid of it.

## Export

Every row a project holds is available as one gzipped NDJSON archive.

From the dashboard, **Data → Download export**. From automation:

```bash
curl -sSL -H "Authorization: Bearer $FLAKEMETRY_TOKEN" \
  https://flakemetry.example.com/v1/export \
  -o flakemetry-web.ndjson.gz
```

The endpoint needs a token carrying the `read` scope. An ingest token is refused.

### What the archive looks like

One JSON object per line, so a project with a million executions never has to fit in
memory on either side:

```json
{"type":"manifest","version":1,"projectId":"…","exportedAt":"2026-08-05T10:00:00.000Z","datasets":["project","run",…]}
{"type":"row","dataset":"run","data":{"id":"…","commit_sha":"abc1234",…}}
{"type":"artifact","key":"org/…/proj/…/run/…/0/shot.png","size":18244,"lastModified":"…"}
{"type":"summary","rows":184203,"artifacts":91,"counts":{"run":812,"test_execution":180440,…}}
```

Read the `summary` line first. It says how much the archive should contain, which is the
only way to tell a truncated download from a small project — both are valid gzip.

### What is left out, and why

| Left out | Reason |
| --- | --- |
| `ingest_token.token_hash` | A hash is an offline attack away from a working token. |
| `notification_channel.secret` | The webhook signing key: whoever holds it can forge deliveries. |
| `project.badge_token` | A public capability URL; rotate it rather than copy it. |
| `ingestion_job` | The ingestion queue. Its payloads are the runs and executions already in the archive. |
| `data_request` | This audit log itself — a record about the tenant rather than part of it. |

Artifacts are listed, not inlined: the archive carries the key, size and timestamp of every
stored object so you can fetch the bytes from your own bucket. Base64 inside an NDJSON
stream would inflate a multi-gigabyte export by a third for no gain.

A test in `packages/queries` reads `schema.prisma` and fails if a table carrying a project
id is neither exported nor explicitly excluded, so a model added later cannot quietly fall
out of the archive.

### Every export is recorded

Each export writes a row to the audit log with who asked, when, and how much was served —
a dashboard download records the user's email, an API call records the token id. The
history is on the **Data** page.

## Retention

Two windows, both optional, set per project on the **Policy** page or globally by the
operator:

| Setting | Environment default | What it prunes |
| --- | --- | --- |
| `executionRetentionDays` | `FLAKEMETRY_EXECUTION_RETENTION_DAYS` | Raw executions and their spans |
| `artifactRetentionDays` | `FLAKEMETRY_ARTIFACT_RETENTION_DAYS` | Objects in the artifact bucket |

Unset means kept forever. The worker sweeps every six hours.

Artifacts are never pruned before the executions that point at them: an execution linking
to a screenshot that no longer exists is worse than either keeping both or dropping both.
If you set an artifact window shorter than the execution window, the execution window wins.

Daily rollups outlive the raw executions they were computed from. That is deliberate —
they carry no error text, no artifact keys and no identifiers beyond the test itself, which
is what makes long-range trends possible on a short retention window.

## Deletion

**Data → Delete** on the project settings page. Owners only, and the project or workspace
slug has to be typed to confirm. Both checks happen on the server.

What happens, in order:

1. **Every ingest token for the scope is revoked immediately**, before anything is deleted.
   The sweep is up to a minute away and CI does not pause for a deletion request; an
   erasure racing an ingest would never converge.
2. A request is queued and the worker picks it up. Deleting a large project outlives an
   HTTP timeout, so a request that gave up halfway would leave a tenant half erased with
   nothing recording how far it got.
3. **Artifacts are removed first.** Once the rows are gone nothing is left that says which
   object keys belonged to the tenant, so a bucket failure after the delete would strand
   them permanently. The prefix is recorded on the request, so a crash before the delete is
   only a retry.
4. The rows are deleted, cascading from the project or the workspace.
5. **The erasure verifies itself.** Every table carrying a project id — asked of the live
   database, not of a list in the source — is counted again, and the bucket prefix is
   listed again. Anything left is recorded as residue and the request is marked failed.

A verified erasure means something was checked, not that a delete statement returned
without an error.

### The audit record survives

The `data_request` row has no foreign key to the tenant it describes, on purpose: a cascade
would delete the evidence along with the data. The subject name and artifact prefix are
copied into the record when the request is made, because afterwards there is nothing left
to read them from.

### What deletion does not cover

Deleting a project or a workspace does not delete **user accounts**. A user is a person who
may belong to several workspaces; removing one of them is not consent to remove the person.
Their sessions, accounts and RCA feedback are removed when the user record is, which today
is a database operation rather than a dashboard button.
