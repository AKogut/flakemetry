export interface StoredObject {
  key: string
  size: number
  lastModified: Date
}

export interface ObjectStore {
  readonly name: string
  presignUpload(key: string, contentType: string, ttlSeconds?: number): Promise<string>
  presignDownload(key: string, ttlSeconds?: number): Promise<string>
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  remove(keys: string[]): Promise<void>
  list(prefix: string): Promise<StoredObject[]>
}

export const DEFAULT_UPLOAD_TTL_SECONDS = 900
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 900

const UNSAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g

export const sanitizeSegment = (value: string): string => {
  const cleaned = value
    .replace(UNSAFE_SEGMENT, '-')
    .replace(/\.\.+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'artifact'
}

export interface ArtifactKeyParts {
  orgId: string
  projectId: string
  idempotencyKey: string
  executionIndex: number
  name: string
}

export const artifactKey = (parts: ArtifactKeyParts): string =>
  [
    'org',
    sanitizeSegment(parts.orgId),
    'proj',
    sanitizeSegment(parts.projectId),
    'run',
    sanitizeSegment(parts.idempotencyKey),
    String(parts.executionIndex),
    sanitizeSegment(parts.name),
  ].join('/')

export const orgArtifactPrefix = (orgId: string): string => `org/${sanitizeSegment(orgId)}/`

export const projectArtifactPrefix = (orgId: string, projectId: string): string =>
  `org/${sanitizeSegment(orgId)}/proj/${sanitizeSegment(projectId)}/`
