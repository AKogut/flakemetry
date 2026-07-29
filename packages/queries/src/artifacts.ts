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

export const signArtifacts = async (
  signer: ArtifactSigner | null | undefined,
  refs: readonly ArtifactRef[],
  ttlSeconds?: number,
): Promise<SignedArtifact[]> =>
  Promise.all(
    refs.map(async (ref) => ({
      name: ref.name,
      contentType: ref.contentType,
      sizeBytes: ref.sizeBytes ?? null,
      url: signer && ref.key ? await signer.presignDownload(ref.key, ttlSeconds) : null,
    })),
  )
