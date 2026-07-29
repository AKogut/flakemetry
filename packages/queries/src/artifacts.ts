import type { ArtifactRef } from '@flakemetry/contracts'

export interface ArtifactSigner {
  presignDownload(key: string, ttlSeconds?: number): Promise<string>
}

export interface SignedArtifact {
  name: string
  contentType: string
  sizeBytes: number | null
  url: string | null
}

export interface SignArtifactsOptions {
  keyPrefix?: string | null
  ttlSeconds?: number
}

export const signArtifacts = async (
  signer: ArtifactSigner | null | undefined,
  refs: readonly ArtifactRef[],
  options: SignArtifactsOptions = {},
): Promise<SignedArtifact[]> =>
  Promise.all(
    refs.map(async (ref) => {
      const withinTenant =
        Boolean(ref.key) && (!options.keyPrefix || ref.key!.startsWith(options.keyPrefix))
      return {
        name: ref.name,
        contentType: ref.contentType,
        sizeBytes: ref.sizeBytes ?? null,
        url:
          signer && withinTenant
            ? await signer.presignDownload(ref.key!, options.ttlSeconds)
            : null,
      }
    }),
  )
