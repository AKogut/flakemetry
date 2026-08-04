# @flakemetry/vitest-reporter

## 0.1.1

### Patch Changes

- 3187041: Report through `onTestRunEnd` as well as `onFinished`.

  Vitest 4 removed `onFinished`, so the reporter was never called on it: the suite passed,
  the reporter stayed silent as it is designed to, and no data reached the server. 0.1.0
  already declares `vitest: ^4` as a peer, so it makes a promise it cannot keep on the
  version it names.

  Both hooks now share one path, so a single build serves Vitest 3 and 4.

- Updated dependencies [3187041]
  - @flakemetry/sdk@0.2.0
