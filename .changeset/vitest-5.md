---
'@flakemetry/vitest-reporter': patch
---

Supports Vitest 5. The peer range was `^4.1.10`, so installing the reporter in a Vitest 5 project failed with `ERESOLVE`, although the reporter itself works unchanged there. It is now `^4.1.10 || ^5.0.0`, and CI runs the reporter under both majors against a live stack.
