import type { NotificationEvent, NotificationType } from './message'

export interface DiscordPayload {
  content: string
  embeds: unknown[]
}

const COLOR: Record<NotificationType, number> = {
  flaky_detected: 0xf5a800,
  quarantine_changed: 0xe11d48,
  rca_ready: 0x5319e7,
  suite_regressed: 0xdc2626,
  suite_slowed: 0xd97706,
}

export const formatDiscord = (event: NotificationEvent): DiscordPayload => ({
  content: event.heading,
  embeds: [
    {
      title: event.heading,
      description: event.summary,
      ...(event.url ? { url: event.url } : {}),
      color: COLOR[event.type],
      ...(event.fields && event.fields.length > 0
        ? {
            fields: event.fields.map((field) => ({
              name: field.label,
              value: field.value,
              inline: true,
            })),
          }
        : {}),
    },
  ],
})
