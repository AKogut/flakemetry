import {
  type Channel,
  createDispatcher,
  isNotificationType,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@flakemetry/notify'

import type { EventBus } from './events'

const parseTypes = (raw: string | undefined): readonly NotificationType[] => {
  if (!raw) return NOTIFICATION_TYPES
  const types = raw
    .split(',')
    .map((value) => value.trim())
    .filter(isNotificationType)
  return types.length > 0 ? types : NOTIFICATION_TYPES
}

const buildChannels = (env: Record<string, string | undefined>): Channel[] => {
  const types = parseTypes(env.FLAKEMETRY_NOTIFY_EVENTS)
  const channels: Channel[] = []
  if (env.FLAKEMETRY_SLACK_WEBHOOK) {
    channels.push({ id: 'slack', kind: 'slack', webhookUrl: env.FLAKEMETRY_SLACK_WEBHOOK, types })
  }
  if (env.FLAKEMETRY_DISCORD_WEBHOOK) {
    channels.push({
      id: 'discord',
      kind: 'discord',
      webhookUrl: env.FLAKEMETRY_DISCORD_WEBHOOK,
      types,
    })
  }
  return channels
}

export const startNotifications = (
  events: EventBus,
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const channels = buildChannels(env)
  if (channels.length === 0) return false

  const dashboardUrl = (env.FLAKEMETRY_DASHBOARD_URL ?? '').replace(/\/+$/, '') || null
  const dispatcher = createDispatcher({
    channels,
    onError: (error) => process.stderr.write(`notify: ${String(error)}\n`),
  })
  const testUrl = (projectId: string, testId: string): string | null =>
    dashboardUrl ? `${dashboardUrl}/projects/${projectId}/tests/${testId}` : null

  events.on('flaky.detected', (payload) => {
    void dispatcher.dispatch({
      type: 'flaky_detected',
      projectId: payload.projectId,
      heading: 'New flaky test detected',
      summary: `\`${payload.suite} › ${payload.title}\` is now flaky (score ${payload.score.toFixed(2)})`,
      url: testUrl(payload.projectId, payload.testIdentityId),
      fields: [
        { label: 'Suite', value: payload.suite },
        { label: 'File', value: payload.filePath },
        { label: 'Score', value: payload.score.toFixed(2) },
      ],
      dedupeKey: `flaky_detected:${payload.testIdentityId}`,
    })
  })

  events.on('quarantine.changed', (payload) => {
    void dispatcher.dispatch({
      type: 'quarantine_changed',
      projectId: payload.projectId,
      heading: payload.quarantined ? 'Test quarantined' : 'Test released from quarantine',
      summary: `\`${payload.suite} › ${payload.title}\` was ${
        payload.quarantined ? 'quarantined' : 'released from quarantine'
      }${payload.reason ? ` — ${payload.reason}` : ''}`,
      url: testUrl(payload.projectId, payload.testIdentityId),
      dedupeKey: `quarantine_changed:${payload.testIdentityId}:${payload.quarantined}`,
    })
  })

  events.on('rca.created', (payload) => {
    void dispatcher.dispatch({
      type: 'rca_ready',
      projectId: payload.projectId,
      heading: 'Root-cause analysis ready',
      summary: `AI root-cause analysis generated for a new failure signature (${payload.model})`,
      url: dashboardUrl ? `${dashboardUrl}/projects/${payload.projectId}/tests` : null,
      dedupeKey: `rca_ready:${payload.signatureId}`,
    })
  })

  return true
}
