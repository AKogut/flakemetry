import { Command } from 'commander'

import { configCommand } from './commands/config'
import { resolveConfig, resolveToken } from './config-loader'
import type { CommandContext } from './registry'
import { CommandRegistry } from './registry'

export * from './config-loader'
export * from './registry'
export { configCommand }

export const CLI_VERSION = '0.0.0'

export const createDefaultRegistry = (): CommandRegistry => new CommandRegistry().add(configCommand)

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
