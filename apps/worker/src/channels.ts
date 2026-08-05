import type { PrismaClient } from '@flakemetry/db'
import {
  type Channel,
  type ChannelKind,
  isNotificationType,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@flakemetry/notify'

import type { ProjectChannelLoader } from './notify'

const isChannelKind = (kind: string): kind is ChannelKind =>
  kind === 'slack' || kind === 'discord' || kind === 'email' || kind === 'webhook'

export interface ChannelRow {
  id: string
  kind: string
  target: string
  events: string[]
  secret?: string | null
}

export const mapChannelRows = (rows: readonly ChannelRow[]): Channel[] =>
  rows
    // A webhook channel with no secret cannot be signed, and sending it unsigned would be
    // worse than not sending it: the receiver would have no way to tell it came from here.
    .filter(
      (row) =>
        isChannelKind(row.kind) &&
        row.target.length > 0 &&
        (row.kind !== 'webhook' || Boolean(row.secret)),
    )
    .map((row) => {
      const types = row.events.filter(isNotificationType) as NotificationType[]
      return {
        id: `db:${row.id}`,
        kind: row.kind as ChannelKind,
        webhookUrl: row.target,
        types: types.length > 0 ? types : NOTIFICATION_TYPES,
        ...(row.secret ? { secret: row.secret } : {}),
      }
    })

const CACHE_TTL_MS = 60_000

export const createProjectChannelLoader = (
  prisma: PrismaClient,
  ttlMs: number = CACHE_TTL_MS,
): ProjectChannelLoader => {
  const cache = new Map<string, { at: number; channels: Channel[] }>()
  return async (projectId) => {
    const cached = cache.get(projectId)
    const at = Date.now()
    if (cached && at - cached.at < ttlMs) return cached.channels
    const rows = await prisma.notificationChannel.findMany({
      where: { projectId, enabled: true },
      select: { id: true, kind: true, target: true, events: true, secret: true },
    })
    const channels = mapChannelRows(rows)
    cache.set(projectId, { at, channels })
    return channels
  }
}
