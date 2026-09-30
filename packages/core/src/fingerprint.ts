import { createHash } from 'node:crypto'

import type { JsonRecord } from '@flakemetry/contracts'

export const normalizeFilePath = (filePath: string): string => {
  const segments: string[] = []
  for (const segment of filePath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/').toLowerCase()
}

export const hashParams = (params: JsonRecord | null | undefined): string | null => {
  if (!params || Object.keys(params).length === 0) return null
  const canonical = JSON.stringify(params, Object.keys(params).sort())
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export interface FingerprintInput {
  filePath: string
  suite: string
  title: string
  paramsHash?: string | null
}

export const computeFingerprint = (input: FingerprintInput): string => {
  const parts = [
    normalizeFilePath(input.filePath),
    input.suite.trim(),
    input.title.trim(),
    input.paramsHash ?? '',
  ]
  return `sha256:${createHash('sha256').update(parts.join(' ')).digest('hex')}`
}
