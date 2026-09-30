---
'@flakemetry/contracts': minor
---

Plugin API version 1: `FlakemetryPlugin`, `definePlugin`, `validatePlugin` and the schemas for plugin signals and parsed reports. An `analyze` hook raises signals on tests after each run, and a `parse` hook teaches the API a new report format at `POST /v1/ingest/plugin/:name`.
