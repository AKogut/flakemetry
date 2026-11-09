---
'@flakemetry/contracts': minor
---

Query results say more about what is actually known. A run list item carries `durationEstimated`, set when `durationMs` was added up from test durations because the report recorded no run time. A test history point carries `durationKnown`, `hasSpans` and `hasArtifacts`, so a page can leave out a trace link with nothing behind it and tell a duration that was never measured from a 0ms test. A stitch carries `runStartedAt`, the time of the run it happened in.
