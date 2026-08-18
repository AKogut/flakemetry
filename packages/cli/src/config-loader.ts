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

export interface ConfigAttempt {
  resolved: ResolvedConfig | null
  error: string | null
}

/**
 * Config resolution that reports a problem instead of raising one. `flakemetry run` wraps a
 * test suite, and a typo in flakemetry.yml must not be the reason a suite never runs — the
 * whole point of the wrapper is that Flakemetry cannot fail a build. Commands that genuinely
 * need the config still check `error` and refuse; the wrapper carries on without it.
 */
export const tryResolveConfig = (
  cwd: string,
  env: Record<string, string | undefined>,
): ConfigAttempt => {
  try {
    return { resolved: resolveConfig(cwd, env), error: null }
  } catch (error) {
    return { resolved: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export const resolveToken = (env: Record<string, string | undefined>): string | null =>
  env.FLAKEMETRY_TOKEN ?? null

export const redactToken = (token: string): string =>
  token.length <= 8 ? '********' : `${token.slice(0, 4)}…${token.slice(-4)}`
