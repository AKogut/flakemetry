---
'@flakemetry/cli': minor
---

Add `run`, `flaky` and `doctor`. `flakemetry run -- pnpm test` wraps a test command, uploads the results afterwards and exits with the command's own code — an upload problem warns but never turns a green build red. `flakemetry flaky` lists the flaky board from the terminal (`--json` for scripting, `--quarantined` to filter), and `flakemetry doctor` reports the configuration, connectivity and what the token is allowed to do, with the token redacted. Both query commands need a token with the `read` scope.
