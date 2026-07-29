import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ArtifactPresignResponse,
  artifactPresignResponseSchema,
  type ArtifactRef,
  isAllowedArtifactContentType,
} from '@flakemetry/contracts'

export interface UploadArtifactsDeps {
  fetchImpl?: typeof fetch
  readFile?: (absolutePath: string) => Uint8Array
}

export interface UploadArtifactsParams {
  endpoint: string
  token: string
  idempotencyKey: string
  rootDir: string
  executions: readonly { artifacts?: ArtifactRef[] | null }[]
  deps?: UploadArtifactsDeps
}

interface PendingArtifact {
  executionIndex: number
  ref: ArtifactRef
  body: Uint8Array
}

export const uploadArtifacts = async (
  params: UploadArtifactsParams,
): Promise<{ uploaded: number }> => {
  const fetchImpl = params.deps?.fetchImpl ?? fetch
  const readFile = params.deps?.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
  const endpoint = params.endpoint.replace(/\/+$/, '')

  const pending: PendingArtifact[] = []
  params.executions.forEach((execution, executionIndex) => {
    for (const ref of execution.artifacts ?? []) {
      if (ref.key || !isAllowedArtifactContentType(ref.contentType)) continue
      let body: Uint8Array
      try {
        body = readFile(join(params.rootDir, ref.path))
      } catch {
        continue
      }
      pending.push({ executionIndex, ref, body })
    }
  })

  if (pending.length === 0) return { uploaded: 0 }

  const presignResponse = await fetchImpl(`${endpoint}/v1/artifacts/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${params.token}` },
    body: JSON.stringify({
      idempotencyKey: params.idempotencyKey,
      artifacts: pending.map((item) => ({
        executionIndex: item.executionIndex,
        name: item.ref.name,
        contentType: item.ref.contentType,
        sizeBytes: item.body.byteLength,
      })),
    }),
  })

  if (!presignResponse.ok) {
    throw new Error(`presign failed with status ${presignResponse.status}`)
  }

  const presign: ArtifactPresignResponse = artifactPresignResponseSchema.parse(
    await presignResponse.json(),
  )

  let uploaded = 0
  for (const item of presign.items) {
    const match = pending.find(
      (candidate) =>
        candidate.executionIndex === item.executionIndex && candidate.ref.name === item.name,
    )
    if (!match) continue

    const put = await fetchImpl(item.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': match.ref.contentType },
      body: match.body,
    })
    if (!put.ok) continue

    match.ref.key = item.key
    match.ref.sizeBytes = match.body.byteLength
    uploaded += 1
  }

  return { uploaded }
}
