---
'@flakemetry/vitest-reporter': patch
---

Installs and reports correctly on every Vitest from 1.6 to 5.

- The peer range was `^4.1.10`, so npm refused the install with `ERESOLVE` on Vitest 5, and on 1.6–3, which the reporter supported before a dependency sweep narrowed the range. It is now `^1.6.0 || ^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0`.
- On Vitest 3, which calls both `onFinished` and `onTestRunEnd`, each run was delivered twice. Outside CI the two deliveries had different idempotency keys, so two runs were stored. A run is now delivered once, and each run of a watch session is still delivered.
