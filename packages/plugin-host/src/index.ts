import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type FlakemetryPlugin, validatePlugin } from '@flakemetry/contracts'

export const DEFAULT_PLUGIN_TIMEOUT_MS = 5_000

export const parsePluginSpecifiers = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0)

export const resolvePluginTimeout = (env: Record<string, string | undefined>): number => {
  const value = Number(env.FLAKEMETRY_PLUGIN_TIMEOUT_MS)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PLUGIN_TIMEOUT_MS
}

const importTarget = (specifier: string, baseDir: string): string =>
  specifier.startsWith('.') || isAbsolute(specifier)
    ? pathToFileURL(resolve(baseDir, specifier)).href
    : specifier

export const loadPlugins = async (
  specifiers: readonly string[],
  baseDir = process.cwd(),
): Promise<FlakemetryPlugin[]> => {
  const plugins: FlakemetryPlugin[] = []
  for (const specifier of specifiers) {
    let loaded: { default?: unknown }
    try {
      loaded = (await import(importTarget(specifier, baseDir))) as { default?: unknown }
    } catch (error) {
      throw new Error(
        `plugin ${specifier} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const plugin = validatePlugin(loaded.default ?? loaded, specifier)
    if (plugins.some((existing) => existing.name === plugin.name)) {
      throw new Error(`two plugins are named ${plugin.name}; plugin names must be unique`)
    }
    plugins.push(plugin)
  }
  return plugins
}

export const loadPluginsFromEnv = (
  env: Record<string, string | undefined>,
  baseDir = process.cwd(),
): Promise<FlakemetryPlugin[]> =>
  loadPlugins(parsePluginSpecifiers(env.FLAKEMETRY_PLUGINS), baseDir)

export class PluginTimeoutError extends Error {
  override readonly name = 'PluginTimeoutError'
}

export const withDeadline = async <T>(
  work: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PluginTimeoutError(`${label} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([Promise.resolve().then(work), expired])
  } finally {
    clearTimeout(timer)
  }
}
