import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  DEFAULT_UPLOAD_TTL_SECONDS,
  type ObjectStore,
  type StoredObject,
} from './store'

export interface S3ObjectStoreOptions {
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
}

export const createS3ObjectStore = (options: S3ObjectStoreOptions): ObjectStore => {
  const client = new S3Client({
    region: options.region ?? 'us-east-1',
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  })
  const bucket = options.bucket

  return {
    name: 's3',

    presignUpload(key, contentType, options = {}) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
        }),
        { expiresIn: options.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS },
      )
    },

    presignDownload(key, ttlSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlSeconds,
      })
    },

    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      )
    },

    async remove(keys) {
      if (keys.length === 0) return
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      )
    },

    async list(prefix) {
      const objects: StoredObject[] = []
      let continuationToken: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue
          objects.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified ?? new Date(0),
          })
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (continuationToken)
      return objects
    },
  }
}
