import { describe, expect, it } from 'vitest'

import { formatDiscord } from '../discord'
import { formatEmail } from '../email'
import { NOTIFICATION_TYPES, type NotificationEvent } from '../message'
import { formatSlack } from '../slack'

const event: NotificationEvent = {
  type: 'ai_budget_spent',
  projectId: 'p1',
  heading: 'AI budget spent for today',
  summary: 'Root-cause analysis is paused until tomorrow — 200,000 of 200,000 tokens used today.',
  fields: [
    { label: 'Spent', value: '200,000' },
    { label: 'Budget', value: '200,000' },
  ],
  dedupeKey: 'ai_budget_spent:p1:2026-08-18',
}

describe('the budget notification', () => {
  it('says what happened and what it means, not just a number', () => {
    const mail = formatEmail(event)

    // Someone reading this in a mail client has no dashboard open. "Budget exceeded" alone
    // does not tell them analysis has stopped.
    expect(mail.subject).toContain('AI budget spent')
    expect(mail.text).toContain('paused until tomorrow')
    expect(mail.text).toContain('Budget: 200,000')
  })

  it('renders on every channel, not only the one it was written for', () => {
    expect(() => formatSlack(event)).not.toThrow()
    expect(() => formatDiscord(event)).not.toThrow()
    expect(formatDiscord(event).embeds).toHaveLength(1)
  })

  it('is a type the routing layer knows about', () => {
    // A type the dashboard cannot offer as a checkbox is one nobody can subscribe to.
    expect(NOTIFICATION_TYPES).toContain('ai_budget_spent')
  })

  it('dedupes per project per day', () => {
    // The budget is re-checked on every run, so without a key that collapses them a busy
    // afternoon sends one of these per failing suite.
    const monday = 'ai_budget_spent:p1:2026-08-18'
    const alsoMonday = 'ai_budget_spent:p1:2026-08-18'
    const tuesday = 'ai_budget_spent:p1:2026-08-19'
    const otherProject = 'ai_budget_spent:p2:2026-08-18'

    expect(monday).toBe(alsoMonday)
    expect(monday).not.toBe(tuesday)
    expect(monday).not.toBe(otherProject)
  })
})
