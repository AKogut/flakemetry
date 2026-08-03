import type { ZodTypeAny } from 'zod'

import {
  artifactPresignRequestSchema,
  codeownersUploadSchema,
  ingestRunBatchSchema,
} from './ingestion'
import { otlpTraceRequestSchema } from './otel'
import {
  flakyBoardInputSchema,
  rcaGetInputSchema,
  runGetInputSchema,
  runsListInputSchema,
  testGetInputSchema,
  testHealthInputSchema,
} from './query'

export type RestAuth = 'none' | 'ingest-token'

export interface RestEndpoint {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  summary: string
  auth: RestAuth
  request?: { name: string; schema: ZodTypeAny }
  response: string
}

export const REST_ENDPOINTS: readonly RestEndpoint[] = [
  {
    method: 'GET',
    path: '/health',
    summary: 'Liveness probe. Used by containers and load balancers.',
    auth: 'none',
    response: '`{ status: "ok", service: "api" }`',
  },
  {
    method: 'POST',
    path: '/v1/ingest',
    summary:
      'Ingest one test run. Validated and enqueued, then acknowledged immediately — this never blocks CI.',
    auth: 'ingest-token',
    request: { name: 'IngestRunBatch', schema: ingestRunBatchSchema },
    response: '`202` with `{ receiptId, acceptedExecutions }`',
  },
  {
    method: 'POST',
    path: '/v1/traces',
    summary: 'OTLP-HTTP trace ingestion for reporters that emit spans directly.',
    auth: 'ingest-token',
    request: { name: 'OtlpTraceRequest', schema: otlpTraceRequestSchema },
    response: '`202` with `{ receiptId, acceptedExecutions }`',
  },
  {
    method: 'POST',
    path: '/v1/artifacts/presign',
    summary:
      'Request a presigned upload URL so a reporter can push screenshots, video and traces straight to object storage.',
    auth: 'ingest-token',
    request: { name: 'ArtifactPresignRequest', schema: artifactPresignRequestSchema },
    response: '`{ url, key, headers }`, or `404` when artifact storage is disabled',
  },
  {
    method: 'GET',
    path: '/v1/runs/summary',
    summary: 'Roll-up for one commit, used by the PR comment action.',
    auth: 'ingest-token',
    response: 'Run summary for the commit, or `404` when it has not been ingested',
  },
  {
    method: 'GET',
    path: '/v1/runs/gate',
    summary:
      'Quality-gate verdict for a commit: which failures are new versus already flaky on the base branch.',
    auth: 'ingest-token',
    response: 'Gate verdict with per-test classification',
  },
  {
    method: 'PUT',
    path: '/v1/codeowners',
    summary: 'Upload the repository CODEOWNERS file so tests can be attributed to their owners.',
    auth: 'ingest-token',
    request: { name: 'CodeownersUpload', schema: codeownersUploadSchema },
    response: '`{ ok: true }`',
  },
  {
    method: 'PUT',
    path: '/v1/notifications/routing',
    summary:
      'Upload notification routing from `flakemetry.yml`, replacing the config-managed channels.',
    auth: 'ingest-token',
    response: '`{ ok: true, channels }`',
  },
]

export interface TrpcProcedure {
  name: string
  summary: string
  input?: { name: string; schema: ZodTypeAny }
}

export const TRPC_PROCEDURES: readonly TrpcProcedure[] = [
  {
    name: 'runs.list',
    summary: 'Paginated run history, filterable by branch, status and time range.',
    input: { name: 'RunsListInput', schema: runsListInputSchema },
  },
  {
    name: 'run.get',
    summary: 'One run with its executions.',
    input: { name: 'RunGetInput', schema: runGetInputSchema },
  },
  {
    name: 'test.get',
    summary: 'One test identity: score, reason codes, stitch history and recent executions.',
    input: { name: 'TestGetInput', schema: testGetInputSchema },
  },
  {
    name: 'flaky.board',
    summary: 'The flaky board — tests ranked by score, optionally scoped to an owner.',
    input: { name: 'FlakyBoardInput', schema: flakyBoardInputSchema },
  },
  {
    name: 'rca.get',
    summary: 'The root-cause report for one execution, when one exists.',
    input: { name: 'RcaGetInput', schema: rcaGetInputSchema },
  },
  {
    name: 'health.metrics',
    summary: 'Flaky MTTR, introduced-versus-resolved and quarantine backlog, optionally per team.',
    input: { name: 'TestHealthInput', schema: testHealthInputSchema },
  },
]
