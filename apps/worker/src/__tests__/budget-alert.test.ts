import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../events'
import { startNotifications } from '../notify'

/**
 * The budget alert is only useful if it travels: the worker emits it deep inside RCA, and
 * three separate pieces have to agree — the event bus name, the notification type, and the
 * channel's subscription list. Testing the formatter alone would pass with any of them
 * broken.
 */
describe('the AI budget alert reaches a channel', () => {
  it('dispatches to a subscribed channel when the budget is spent', async () => {
    const delivered: string[] = []
    const events = createEventBus(() => undefined)

    const enabled = startNotifications(
      events,
      {
        FLAKEMETRY_SLACK_WEBHOOK: 'https://hooks.slack.com/services/probe',
        FLAKEMETRY_NOTIFY_EVENTS: 'ai_budget_spent',
      },
      () => Promise.resolve([]),
    )
    expect(enabled, 'notifications did not start — the rest proves nothing').toBe(true)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      delivered.push(String(init.body))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    try {
      events.emit('ai.budget.spent', { projectId: 'p1', spent: 200_000, budget: 200_000 })
      await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0), { timeout: 5000 })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(delivered.join()).toContain('paused until tomorrow')
  })
})
