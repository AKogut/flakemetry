# ADR-0004: Asynchronous ingestion — 202 plus durable queue

- **Status**: accepted
- **Date**: 2026-07-15

## Context

Ingestion is called from CI, and CI time is the most expensive resource the platform touches. Processing a batch involves identity resolution, score updates, signature clustering and potentially LLM calls — work measured in seconds, none of which a CI job should wait for. CI runs also finish in bursts (a monorepo push fans out dozens of parallel jobs), so the write path must absorb spikes.

## Decision

The ingestion api does the minimum synchronously: authenticate the project token, validate against the contract, enqueue the payload, respond `202 Accepted` with a receipt id. All processing happens in workers consuming a durable Postgres-backed queue (`FOR UPDATE SKIP LOCKED`) with at-least-once delivery, idempotency keyed per run, retry with backoff and a dead-letter state. Reporters fail open — an unreachable endpoint never fails the test job.

## Alternatives considered

- **Synchronous processing in the request path** — simplest to build, couples CI latency to processing depth, collapses under burst load. Rejected outright.
- **Dedicated broker (Redis Streams, RabbitMQ, Kafka) from day one** — better throughput ceilings, but each adds an operational dependency that contradicts the one-command self-host promise. Postgres already ships with the stack and is transactional with the write. The queue sits behind an interface so a broker can replace it at scale (M5) without touching producers or consumers.

## Consequences

- p99 ingestion latency is independent of processing backlog; CI never blocks on Flakemetry.
- At-least-once delivery plus idempotency keys make re-delivery safe; duplicate batches cannot double-count.
- Results appear in the dashboard with a processing lag — the UI must communicate freshness honestly.
- Queue depth becomes the platform's primary health metric and backpressure signal.
