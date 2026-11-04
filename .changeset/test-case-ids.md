---
'@flakemetry/core': minor
---

Add `extractTestCaseId`, which reads a test-case id from a test title, so the same case can be recognised across runners that name it differently. By default it accepts `TC`, letters and digits separated by `-` or `_`, and returns the id as `TC-AUTH-001`. Pass a pattern for another shape.
