import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../events'

describe('createEventBus', () => {
  it('delivers a payload to every subscriber of that event', () => {
    const bus = createEventBus()
    const first = vi.fn()
    const second = vi.fn()
    bus.on('run.processed', first)
    bus.on('run.processed', second)

    bus.emit('run.processed', {
      runId: 'r1',
      projectId: 'p1',
      executions: 2,
      newIdentities: 1,
      movedIdentities: 0,
    })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0]?.[0]).toMatchObject({ runId: 'r1', executions: 2 })
  })

  it('does not deliver to subscribers of other events', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('identity.created', handler)

    bus.emit('score.updated', {
      testIdentityId: 't1',
      projectId: 'p1',
      score: 0.4,
      quarantineCandidate: false,
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const off = bus.on('identity.moved', handler)
    off()

    bus.emit('identity.moved', { testIdentityId: 't1', projectId: 'p1', alias: 'a' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('isolates a throwing subscriber from the rest', () => {
    const onError = vi.fn()
    const bus = createEventBus(onError)
    const healthy = vi.fn()
    bus.on('identity.created', () => {
      throw new Error('boom')
    })
    bus.on('identity.created', healthy)

    bus.emit('identity.created', { testIdentityId: 't1', projectId: 'p1', fingerprint: 'fp' })

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
