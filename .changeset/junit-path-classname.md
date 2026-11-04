---
'@flakemetry/contracts': patch
---

A JUnit `classname` that is already a path, which is what Vitest writes, is kept as a path instead of having its dots turned into slashes.
