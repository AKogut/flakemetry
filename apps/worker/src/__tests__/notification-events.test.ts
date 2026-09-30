import { flakemetryConfigSchema, NOTIFICATION_EVENTS } from '@flakemetry/contracts'
import { NOTIFICATION_TYPES } from '@flakemetry/notify'
import { describe, expect, it } from 'vitest'

describe('notification events', () => {
  it('every event the worker can send can be subscribed to from flakemetry.yml', () => {
    expect([...NOTIFICATION_EVENTS].sort()).toEqual([...NOTIFICATION_TYPES].sort())
  })

  it('accepts the budget alert in a config file channel', () => {
    const config = flakemetryConfigSchema.parse({
      notifications: {
        channels: [{ kind: 'email', target: 'oncall@example.com', events: ['ai_budget_spent'] }],
      },
    })

    expect(config.notifications?.channels[0]?.events).toEqual(['ai_budget_spent'])
  })
})
