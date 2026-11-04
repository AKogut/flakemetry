import type { NotificationEvent, NotificationType } from './message'

export interface DiscordPayload {
  content: string
  embeds: unknown[]
  allowed_mentions: { parse: string[] }
}

const MAX_TITLE = 256
const MAX_DESCRIPTION = 2000
const MAX_FIELDS = 10
const MAX_FIELD_NAME = 64
const MAX_FIELD_VALUE = 300

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

const COLOR: Record<NotificationType, number> = {
  flaky_detected: 0xf5a800,
  quarantine_changed: 0xe11d48,
  rca_ready: 0x5319e7,
  suite_regressed: 0xdc2626,
  suite_slowed: 0xd97706,
  ai_budget_spent: 0x6b7280,
}

export const formatDiscord = (event: NotificationEvent): DiscordPayload => {
  const fields = (event.fields ?? [])
    .filter((field) => field.label.trim().length > 0 && field.value.trim().length > 0)
    .slice(0, MAX_FIELDS)
  const heading = clip(event.heading, MAX_TITLE)

  return {
    content: heading,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: heading,
        description: clip(event.summary, MAX_DESCRIPTION),
        ...(event.url ? { url: event.url } : {}),
        color: COLOR[event.type],
        ...(fields.length > 0
          ? {
              fields: fields.map((field) => ({
                name: clip(field.label, MAX_FIELD_NAME),
                value: clip(field.value, MAX_FIELD_VALUE),
                inline: true,
              })),
            }
          : {}),
      },
    ],
  }
}
