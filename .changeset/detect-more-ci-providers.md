---
'@flakemetry/sdk': minor
---

Detect GitLab CI, CircleCI and Jenkins.

Runs outside GitHub Actions were reported as `local`, at commit `0000000` on branch
`local`. A whole project's history collapsing onto one commit is read by scoring as
"same commit, different result" — the flakiness signal — so it manufactured flakiness for
every test on those platforms, left the pull-request gate without a base branch to
compare against, and fell back to a per-process idempotency key so parallel jobs never
deduplicated.

CircleCI numbers its parallel containers from zero and Flakemetry from one; the index is
translated so a shard means the same thing whichever platform produced it.
