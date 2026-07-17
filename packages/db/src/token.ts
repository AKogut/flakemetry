import { createHash, randomBytes } from 'node:crypto'

export const TOKEN_PREFIX = 'fmk_'

export const generateToken = (): string => `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`

export const hashToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex')

export const redactToken = (token: string): string =>
  token.length <= 12 ? '********' : `${token.slice(0, 8)}…${token.slice(-4)}`
