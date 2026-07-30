import type { NotificationEvent } from './message'

export interface SlackPayload {
  text: string
  blocks: unknown[]
}

export const formatSlack = (event: NotificationEvent): SlackPayload => {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: event.heading, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: event.summary } },
  ]

  if (event.fields && event.fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: event.fields.map((field) => ({
        type: 'mrkdwn',
        text: `*${field.label}*\n${field.value}`,
      })),
    })
  }

  if (event.url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Flakemetry', emoji: true },
          url: event.url,
        },
      ],
    })
  }

  return { text: `${event.heading} — ${event.summary}`, blocks }
}
