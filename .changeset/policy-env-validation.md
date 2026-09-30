---
'@flakemetry/contracts': patch
---

A policy environment variable that is not a valid value for its field is now ignored instead of becoming `NaN`. `FLAKEMETRY_AI_DAILY_TOKEN_BUDGET=200k` used to remove the AI spending cap altogether; it now leaves the project's own setting in charge. The same check applies to every numeric policy variable and uses the ranges the Policy page accepts. `POLICY_ENV_VARIABLES` lists them.
