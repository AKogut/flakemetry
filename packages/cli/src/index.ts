import { Command } from 'commander'

import { configCommand } from './commands/config'
import { importCommand } from './commands/import'
import { junitCommand } from './commands/junit'
import { uploadCommand } from './commands/upload'
import { resolveConfig, resolveToken } from './config-loader'
import type { CommandContext } from './registry'
import { CommandRegistry } from './registry'

export * from './commands/import'
export * from './commands/junit'
export * from './commands/upload'
export * from './config-loader'
export * from './registry'
export { configCommand, importCommand, junitCommand, uploadCommand }

export const CLI_VERSION = '0.0.0'

export const createDefaultRegistry = (): CommandRegistry =>
  new CommandRegistry().add(configCommand).add(uploadCommand).add(junitCommand).add(importCommand)

export const buildProgram = (
  cwd: string,
  env: Record<string, string | undefined>,
  registry: CommandRegistry = createDefaultRegistry(),
): Command => {
  const program = new Command()
  program.name('flakemetry').description('Flakemetry command line interface').version(CLI_VERSION)
  const context: CommandContext = {
    cwd,
    env,
    resolveConfig: () => resolveConfig(cwd, env),
    token: resolveToken(env),
  }
  registry.applyTo(program, context)
  return program
}
