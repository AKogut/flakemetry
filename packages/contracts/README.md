# @flakemetry/contracts

The single source of truth for [Flakemetry](https://github.com/AKogut/flakemetry) data shapes: zod schemas and their inferred types, shared by the SDK, ingestion API, worker and dashboard.

## Install

```bash
pnpm add @flakemetry/contracts
```

## What is in here

- **Ingestion contract** — `ingestRunBatchSchema`, the normalized run/execution payload every transport converges on.
- **OTel test conventions** — `SPAN_NAMES`, `RESOURCE_ATTR`, `SPAN_ATTR` are defined here, so the wire format and the schemas cannot drift apart. Documented in [otel-conventions.md](https://github.com/AKogut/flakemetry/blob/main/docs/otel-conventions.md).
- **OTLP mapping** — `otlpTraceRequestSchema` validates an OTLP/HTTP JSON export and `otlpToIngestBatch` normalizes it into the ingestion contract.
- **Query DTOs** — inputs and results for the read API (runs list, run detail, test detail, flaky board, RCA).
- **Config** — `flakemetryConfigSchema` plus layered merging and environment overrides.

```ts
import { ingestRunBatchSchema, otlpToIngestBatch, otlpTraceRequestSchema } from '@flakemetry/contracts'

const otlp = otlpTraceRequestSchema.parse(requestBody)
const batch = ingestRunBatchSchema.parse(otlpToIngestBatch(otlp))
```

Everything is a zod schema first and a TypeScript type second, so validation and typing never disagree.

## License

MIT © Andrii Kohut
