import type { Command } from 'commander'

import type { ResolvedConfig } from './config-loader'

export interface CommandContext {
  cwd: string
  env: Record<string, string | undefined>
  resolveConfig: () => ResolvedConfig
  token: string | null
}

export interface CommandModule {
  name: string
  description: string
  register: (program: Command, context: CommandContext) => void
}

export class CommandRegistry {
  private readonly modules = new Map<string, CommandModule>()

  add(module: CommandModule): this {
    if (this.modules.has(module.name)) {
      throw new Error(`command "${module.name}" is already registered`)
    }
    this.modules.set(module.name, module)
    return this
  }

  list(): CommandModule[] {
    return [...this.modules.values()]
  }

  applyTo(program: Command, context: CommandContext): void {
    for (const module of this.modules.values()) {
      module.register(program, context)
    }
  }
}
