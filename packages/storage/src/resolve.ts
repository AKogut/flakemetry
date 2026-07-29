import { createS3ObjectStore, type S3ObjectStoreOptions } from './s3'
import type { ObjectStore } from './store'

export interface ResolveObjectStoreDeps {
  createS3?: (options: S3ObjectStoreOptions) => ObjectStore
}

export const resolveObjectStore = (
  env: Record<string, string | undefined>,
  deps: ResolveObjectStoreDeps = {},
): ObjectStore | null => {
  const bucket = env.FLAKEMETRY_S3_BUCKET
  if (!bucket) return null

  const makeS3 = deps.createS3 ?? createS3ObjectStore
  const forcePathStyle = env.FLAKEMETRY_S3_FORCE_PATH_STYLE
    ? env.FLAKEMETRY_S3_FORCE_PATH_STYLE === 'true'
    : undefined

  return makeS3({
    bucket,
    region: env.FLAKEMETRY_S3_REGION || undefined,
    endpoint: env.FLAKEMETRY_S3_ENDPOINT || undefined,
    accessKeyId: env.FLAKEMETRY_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.FLAKEMETRY_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || undefined,
    ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
  })
}
