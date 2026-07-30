export const DEFAULT_CLUSTER_THRESHOLD = 0.5

export const tokenizeError = (text: string): Set<string> => {
  const normalized = text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, ' ')
    .replace(/[0-9a-f]{8,}/g, ' ')
    .replace(/\d+/g, ' ')
  const tokens = normalized.split(/[^a-z]+/).filter((token) => token.length >= 3)
  return new Set(tokens)
}

export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

export interface ClusterCandidate {
  clusterId: string | null
  tokens: ReadonlySet<string>
}

export interface NearestCluster<T extends ClusterCandidate> {
  candidate: T
  similarity: number
}

export const nearestCluster = <T extends ClusterCandidate>(
  target: ReadonlySet<string>,
  candidates: readonly T[],
  threshold: number = DEFAULT_CLUSTER_THRESHOLD,
): NearestCluster<T> | null => {
  let best: NearestCluster<T> | null = null
  for (const candidate of candidates) {
    const similarity = jaccard(target, candidate.tokens)
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { candidate, similarity }
    }
  }
  return best
}

export const errorTokens = (message: string, stackTemplate?: string | null): Set<string> =>
  tokenizeError(stackTemplate ? `${message} ${stackTemplate}` : message)
