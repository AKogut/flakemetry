---
'@flakemetry/contracts': patch
'@flakemetry/cli': patch
---

Stop a broken `flakemetry.yml` from failing a build, and make the tracker's environment settings work.

`flakemetry run` resolved the config before spawning the wrapped command, so an invalid config file raised and the test suite never ran — the wrapper exists precisely so that Flakemetry cannot fail a build. It now warns and carries on. Config errors also arrive as a diagnosis rather than a Node stack trace.

`FLAKEMETRY_TRACKER_ENABLED`, `FLAKEMETRY_TRACKER_AFTER_DAYS` and `FLAKEMETRY_TRACKER_RECOVERY_DAYS` were documented, passed through both compose files, and read by nothing. They now reach the policy layer like every other setting.
