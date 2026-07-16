import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { FlakemetryConfig } from '@flakemetry/contracts'
import { configFromEnv, mergeConfigLayers } from '@flakemetry/contracts'
import { parse } from 'yaml'

const CONFIG_FILENAMES = ['flakemetry.yml', 'flakemetry.yaml']

export const findConfigFile = (startDir: string): string | null => {
  let current = startDir
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(current, filename)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export const loadFileConfig = (path: string): unknown => parse(readFileSync(path, 'utf8'))

export interface ResolvedConfig {
  config: FlakemetryConfig
  configPath: string | null
}

export const resolveConfig = (
  cwd: string,
  env: Record<string, string | undefined>,
): ResolvedConfig => {
  const configPath = findConfigFile(cwd)
  const fileConfig = configPath ? loadFileConfig(configPath) : undefined
  const config = mergeConfigLayers(fileConfig, configFromEnv(env))
  return { config, configPath }
}

export const resolveToken = (env: Record<string, string | undefined>): string | null =>
  env.FLAKEMETRY_TOKEN ?? null

export const redactToken = (token: string): string =>
  token.length <= 8 ? '********' : `${token.slice(0, 4)}…${token.slice(-4)}`
