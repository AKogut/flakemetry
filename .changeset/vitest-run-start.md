---
'@flakemetry/vitest-reporter': patch
---

A run now starts when Vitest starts it. It was recorded as starting when it finished, so its duration read a few milliseconds.
