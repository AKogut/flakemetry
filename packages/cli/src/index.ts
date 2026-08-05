import { Command } from 'commander'

import { configCommand } from './commands/config'
import { doctorCommand } from './commands/doctor'
import { flakyCommand } from './commands/flaky'
import { importCommand } from './commands/import'
import { junitCommand } from './commands/junit'
import { runCommand } from './commands/run'
import { uploadCommand } from './commands/upload'
import { resolveConfig, resolveToken } from './config-loader'
import type { CommandContext } from './registry'
import { CommandRegistry } from './registry'

export * from './commands/doctor'
export * from './commands/flaky'
export * from './commands/import'
export * from './commands/junit'
export * from './commands/run'
export * from './commands/upload'
export * from './config-loader'
export * from './registry'
export { configCommand, importCommand, junitCommand, uploadCommand }

export const CLI_VERSION = '0.0.0'

export const createDefaultRegistry = (): CommandRegistry =>
  new CommandRegistry()
    .add(configCommand)
    .add(runCommand)
    .add(uploadCommand)
    .add(junitCommand)
    .add(importCommand)
    .add(flakyCommand)
    .add(doctorCommand)

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
