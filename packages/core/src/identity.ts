import { createHash } from 'node:crypto'

export interface IdentityCandidate {
  fingerprint: string
  suite: string
  title: string
  paramsHash: string | null
  filePath?: string
}

export interface ExistingIdentity {
  id: string
  fingerprint: string
  suite: string
  title: string
  paramsHash: string | null
  aliases: readonly string[]
  filePath?: string
}

export type IdentityResolution =
  | { kind: 'exact'; identityId: string; level: 'L1' }
  | { kind: 'moved'; identityId: string; level: 'L2'; addAlias: string }
  | { kind: 'renamed'; identityId: string; level: 'L3'; addAlias: string; confidence: number }
  | { kind: 'new' }

export const RENAME_CONFIDENCE_THRESHOLD = 0.5

export const RENAME_AMBIGUITY_MARGIN = 0.2

export interface ResolveContext {
  presentTitleKeys?: ReadonlySet<string>
}

const movedKey = (node: { suite: string; title: string; paramsHash: string | null }): string =>
  createHash('sha256')
    .update([node.suite.trim(), node.title.trim(), node.paramsHash ?? ''].join(' '))
    .digest('hex')

const titleTokens = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  )

export const titleSimilarity = (a: string, b: string): number => {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const token of ta) if (tb.has(token)) intersection += 1
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : intersection / union
}

export const bucketTitleKey = (node: {
  filePath?: string
  suite: string
  paramsHash: string | null
  title: string
}): string => [node.filePath ?? '', node.suite, node.paramsHash ?? '', node.title].join('\u0000')

export const collectPresentTitleKeys = (
  executions: readonly {
    filePath?: string
    suite: string
    paramsHash: string | null
    title: string
  }[],
): Set<string> => new Set(executions.map(bucketTitleKey))

const sameBucket = (candidate: IdentityCandidate, entry: ExistingIdentity): boolean =>
  candidate.filePath != null &&
  entry.filePath != null &&
  candidate.filePath === entry.filePath &&
  candidate.suite === entry.suite &&
  (candidate.paramsHash ?? '') === (entry.paramsHash ?? '') &&
  candidate.title !== entry.title

export const resolveIdentity = (
  candidate: IdentityCandidate,
  existing: readonly ExistingIdentity[],
  context: ResolveContext = {},
): IdentityResolution => {
  const exact = existing.find(
    (entry) =>
      entry.fingerprint === candidate.fingerprint || entry.aliases.includes(candidate.fingerprint),
  )
  if (exact) return { kind: 'exact', identityId: exact.id, level: 'L1' }

  const candidateKey = movedKey(candidate)
  const moved = existing.find((entry) => movedKey(entry) === candidateKey)
  if (moved) {
    return { kind: 'moved', identityId: moved.id, level: 'L2', addAlias: candidate.fingerprint }
  }

  const present = context.presentTitleKeys
  const renameMatches = existing
    .filter((entry) => sameBucket(candidate, entry))
    .filter((entry) => !present?.has(bucketTitleKey(entry)))
    .map((entry) => ({ entry, confidence: titleSimilarity(entry.title, candidate.title) }))
    .filter((match) => match.confidence >= RENAME_CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)

  const best = renameMatches[0]
  const runnerUp = renameMatches[1]
  const unambiguous =
    best !== undefined &&
    (runnerUp === undefined || best.confidence - runnerUp.confidence >= RENAME_AMBIGUITY_MARGIN)
  if (best && unambiguous) {
    return {
      kind: 'renamed',
      identityId: best.entry.id,
      level: 'L3',
      addAlias: candidate.fingerprint,
      confidence: best.confidence,
    }
  }

  return { kind: 'new' }
}
