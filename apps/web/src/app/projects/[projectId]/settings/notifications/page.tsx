import { getPrismaClient } from '@flakemetry/db'

import { createNotificationChannel, deleteNotificationChannel } from '@/lib/actions'
import { NOTIFY_EVENTS } from '@/lib/notify-events'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const EVENT_LABELS: Record<string, string> = {
  flaky_detected: 'Flaky detected',
  quarantine_changed: 'Quarantine changed',
  rca_ready: 'RCA ready',
  suite_regressed: 'Suite regression',
}

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)
  const canEdit = project.role === 'owner' || project.role === 'admin'

  const channels = await prisma.notificationChannel.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, target: true, events: true, enabled: true },
  })

  const maskTarget = (target: string): string =>
    target.length <= 24 ? target : `${target.slice(0, 20)}…${target.slice(-4)}`

  return (
    <>
      <h1 className="page-title">Notifications</h1>
      <p className="page-subtitle">
        Post flaky detections, quarantine changes, RCA reports, and suite regressions to Slack,
        Discord, or email for this project. Global{' '}
        <span className="mono">FLAKEMETRY_SLACK_WEBHOOK</span> /{' '}
        <span className="mono">FLAKEMETRY_DISCORD_WEBHOOK</span> /{' '}
        <span className="mono">FLAKEMETRY_EMAIL_TO</span> channels still apply on top of these.
      </p>

      {!canEdit ? (
        <div className="notice-box" style={{ borderLeftColor: 'var(--muted)' }}>
          You have read-only access. Only owners and admins can manage notifications.
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        {channels.length === 0 ? (
          <div className="empty">No channels yet — add one below.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Webhook</th>
                <th>Events</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td className="mono">{channel.kind}</td>
                  <td className="mono muted">{maskTarget(channel.target)}</td>
                  <td className="muted">
                    {channel.events.length === 0
                      ? 'all'
                      : channel.events.map((event) => EVENT_LABELS[event] ?? event).join(', ')}
                  </td>
                  <td>
                    {canEdit ? (
                      <form action={deleteNotificationChannel}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="channelId" value={channel.id} />
                        <button className="btn btn-ghost" type="submit">
                          Remove
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canEdit ? (
        <div className="card">
          <h2 className="page-title" style={{ fontSize: '1.1rem' }}>
            Add a channel
          </h2>
          <form action={createNotificationChannel}>
            <input type="hidden" name="projectId" value={projectId} />
            <div className="policy-field">
              <div>
                <label htmlFor="kind">Kind</label>
                <select id="kind" name="kind" defaultValue="slack">
                  <option value="slack">Slack</option>
                  <option value="discord">Discord</option>
                  <option value="email">Email</option>
                </select>
              </div>
            </div>
            <div className="policy-field">
              <div>
                <label htmlFor="target">Webhook URL or email address</label>
                <input
                  id="target"
                  name="target"
                  type="text"
                  placeholder="https://hooks.slack.com/services/…  or  alerts@acme.com"
                  required
                />
                <p className="policy-help">
                  Slack/Discord take an https webhook URL; email takes a recipient address (requires{' '}
                  <span className="mono">FLAKEMETRY_SMTP_*</span> on the worker).
                </p>
              </div>
            </div>
            <div className="policy-field">
              <div className="policy-label">Events (leave all unchecked for every event)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                {NOTIFY_EVENTS.map((event) => (
                  <label key={event} style={{ display: 'inline-flex', gap: '0.35rem' }}>
                    <input type="checkbox" name={`event:${event}`} />
                    {EVENT_LABELS[event] ?? event}
                  </label>
                ))}
              </div>
            </div>
            <button className="btn" type="submit" style={{ marginTop: '1rem' }}>
              Add channel
            </button>
          </form>
        </div>
      ) : null}
    </>
  )
}
