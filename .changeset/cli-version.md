---
'@flakemetry/cli': patch
---

`flakemetry --version` reported `0.0.0` regardless of the installed version. It now reports the real one, baked in at build time — the version is the first thing anyone is asked for in a bug report, and `0.0.0` identified nothing.
