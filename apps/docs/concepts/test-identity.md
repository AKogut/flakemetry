# Test identity

A test's value as telemetry depends on its history staying attached to it. If a test loses
its identity every time a file moves or a title is tweaked, its flaky score resets to zero
and the platform is blind exactly when a refactor is most likely to have introduced a
regression. The **test identity engine** keeps one stable identity across those changes.

## Why a naive key fails

The obvious identity — `filePath + suite + title` — breaks the moment any of those change.
Move `login.spec.ts` into a folder, rename `should log in` to `logs in`, or parameterize a
test, and a naive key treats it as a brand-new test with no history. Real codebases do all
three constantly.

## Multi-level resolution

Identity is resolved in levels, from strongest to weakest signal. The first level that
matches wins, and history is stitched onto the existing identity:

- **L1 — exact.** Same file path, suite, title, and parameters. The common case.
- **L2 — moved.** Same suite, title, and params but a different file path — the test moved.
  Matched by content so a file move keeps its history.
- **L3 — renamed.** Same file and suite but a changed title, matched by structural
  similarity so a rename does not fork the history.
- **L4 — parameterized.** Data-driven cases are grouped so a bucket of parameters rolls up
  to one logical test rather than fragmenting the score across every input.

Because identity is computed **server-side** from `filePath + suite + title + params`, the
resolution is identical no matter which reporter produced the run — Playwright, Vitest,
Jest, or a JUnit upload. The reporters never send a fingerprint; they send the raw
coordinates and the server decides.

## Confidence and history re-stitching

Higher levels (moved, renamed) carry a confidence signal, and manual merge/split plus
history re-stitching let a human correct the rare mismatch. Those controls are being
expanded on the [roadmap](https://github.com/users/AKogut/projects/14).

The full algorithm lives in the
[Test Identity Engine wiki page](https://github.com/AKogut/flakemetry/wiki/Test-Identity-Engine).
