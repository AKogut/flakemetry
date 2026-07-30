import { describe, expect, it } from 'vitest'

import { errorTokens, jaccard, nearestCluster, tokenizeError } from '../clustering'

describe('tokenizeError', () => {
  it('drops numbers and hex so timeout-value variants collapse', () => {
    const a = tokenizeError('locator.click: Timeout 30000ms exceeded')
    const b = tokenizeError('locator.click: Timeout 45000ms exceeded')
    expect(jaccard(a, b)).toBe(1)
  })

  it('keeps distinct wording apart', () => {
    const a = tokenizeError('Timeout 30000ms exceeded waiting for selector')
    const b = tokenizeError('Received status 500 Internal Server Error')
    expect(jaccard(a, b)).toBeLessThan(0.2)
  })
})

describe('nearestCluster', () => {
  const candidates = [
    { clusterId: 'cluster-timeout', tokens: errorTokens('Timeout 30000ms exceeded on click') },
    { clusterId: 'cluster-http', tokens: errorTokens('Request failed with status 500') },
  ]

  it('matches a paraphrased failure to the nearest cluster above the threshold', () => {
    const target = errorTokens('Timeout 12000ms exceeded on click')
    const match = nearestCluster(target, candidates, 0.5)
    expect(match?.candidate.clusterId).toBe('cluster-timeout')
  })

  it('returns null when nothing clears the threshold', () => {
    const target = errorTokens('Element is not attached to the DOM')
    expect(nearestCluster(target, candidates, 0.5)).toBeNull()
  })

  it('honours a tunable threshold', () => {
    const target = errorTokens('Timeout 12000ms exceeded')
    expect(nearestCluster(target, candidates, 0.99)).toBeNull()
    expect(nearestCluster(target, candidates, 0.3)?.candidate.clusterId).toBe('cluster-timeout')
  })
})
