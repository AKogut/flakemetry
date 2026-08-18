#!/usr/bin/env node
import { ConfigValidationError } from '@flakemetry/contracts'

import { buildProgram } from './index'

/**
 * A configuration mistake is a diagnosis, not a crash. Without this a typo in
 * flakemetry.yml reaches the user as a Node stack trace naming a bundled chunk, which
 * buries the one part that is actually useful — the list of what is wrong with the file.
 */
const report = (error: unknown): never => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`flakemetry: ${error.message}\n`)
    process.exit(1)
  }
  throw error
}

process.on('uncaughtException', report)
process.on('unhandledRejection', report)

try {
  buildProgram(process.cwd(), process.env).parse()
} catch (error) {
  report(error)
}
