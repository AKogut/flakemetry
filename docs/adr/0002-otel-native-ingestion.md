# ADR-0002: OpenTelemetry-native ingestion — tests as traces

- **Status**: accepted
- **Date**: 2026-07-15

## Context

Every incumbent test-reporting tool defines a bespoke wire format (JUnit XML, Allure results, ReportPortal API). Those formats capture a single run as a static artifact: no trace context, no correlation with application telemetry, and every downstream feature starts by re-parsing a snapshot.

Flakemetry's core features — historical analytics, flaky scoring, root-cause analysis — all consume *telemetry-shaped* data: timed, attributed, hierarchical events.

## Decision

Test executions are modelled as OpenTelemetry spans from day one. Reporters emit OTLP/HTTP; the span hierarchy is `test.run` → `test.case` → `test.step` (with `http` and `browser.action` children later). Semantic conventions (resource and span attributes) are specified in the contracts package and documented for third-party reporter authors.

## Alternatives considered

- **Custom JSON contract first, OTLP later** — faster MVP, but retrofitting OTel means maintaining two ingestion paths and migrating every early adopter. The "tests as traces" positioning is the differentiator; deferring it undermines the moat.
- **JUnit XML ingestion as the primary path** — maximum compatibility, minimum information. XML carries no timing hierarchy, no attributes, no retry linkage. Kept as a compatibility adapter (M4), not the native format.

## Consequences

- Reporters reuse mature OTel SDKs instead of a bespoke client; batching, retry and export semantics come for free.
- Test telemetry can join application traces — a failing E2E test links to the backend spans it triggered.
- OTLP is more complex than a flat JSON POST; the ingestion api must handle protobuf and span-tree normalization, paid once in the worker.
- Flakemetry becomes a citizen of the observability ecosystem rather than a silo.
