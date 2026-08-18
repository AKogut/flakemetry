export type NotificationType =
  | 'flaky_detected'
  | 'quarantine_changed'
  | 'rca_ready'
  | 'suite_regressed'
  | 'suite_slowed'
  | 'ai_budget_spent'

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'flaky_detected',
  'quarantine_changed',
  'rca_ready',
  'suite_regressed',
  'suite_slowed',
  'ai_budget_spent',
]

export interface NotificationField {
  label: string
  value: string
}

export interface NotificationEvent {
  type: NotificationType
  projectId: string
  heading: string
  summary: string
  url?: string | null
  fields?: NotificationField[]
  dedupeKey: string
}

export const isNotificationType = (value: string): value is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(value)
