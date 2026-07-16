import { redactToken } from '../config-loader'
import type { CommandModule } from '../registry'

export const configCommand: CommandModule = {
  name: 'config',
  description: 'Print the resolved configuration',
  register: (program, context) => {
    program
      .command('config')
      .description('Print the resolved configuration and its sources')
      .option('--json', 'output as JSON')
      .action((options: { json?: boolean }) => {
        const { config, configPath } = context.resolveConfig()
        const token = context.token
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ configPath, config, tokenPresent: token !== null }, null, 2)}\n`,
          )
          return
        }
        process.stdout.write(`config file: ${configPath ?? '(none, defaults + env)'}\n`)
        process.stdout.write(`token: ${token ? redactToken(token) : '(not set)'}\n`)
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
      })
  },
}
