---
'@flakemetry/playwright-reporter': patch
---

Installs on Playwright 1.44 and later again. A dependency update had narrowed the peer range to `^1.62.1`, so npm refused the install on older Playwright releases, although the reporter works unchanged on them. It was checked on 1.44.1 and 1.63.0.
