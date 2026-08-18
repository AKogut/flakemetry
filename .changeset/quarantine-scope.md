---
'@flakemetry/contracts': minor
'@flakemetry/cli': minor
---

Add the `quarantine` token scope and `flakemetry quarantine`.

`TOKEN_SCOPES` gains a third entry alongside `ingest` and `read`. It is separate because it is the one call that can stop a failing test from blocking a build, and that should be granted deliberately rather than arriving with the ability to read. Anything narrowing a `TokenScope` union will see the new member.

`flakemetry quarantine <testId>` holds a test in or out of quarantine by hand, and `--auto` hands it back to the scorer. A decision made this way is not overwritten on the next run.
