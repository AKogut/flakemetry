---
'@flakemetry/contracts': minor
'@flakemetry/cli': minor
---

New `flakemetry allure` and `flakemetry xcresult` commands upload Allure results and the JSON from `xcresulttool`. Unlike JUnit, both keep every attempt, so a test that failed and then passed on retry is recorded as flaky.
