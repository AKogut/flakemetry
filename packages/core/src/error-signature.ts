import { createHash } from 'node:crypto'

export interface ErrorSignatureResult {
  normalizedHash: string
  template: string
  stackTemplate: string
}

const normalize = (input: string): string =>
  input
    .replace(/0x[0-9a-fA-F]+/g, '0xN')
    .replace(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      '<uuid>',
    )
    .replace(/"[^"]*"|'[^']*'/g, '<str>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()

export const computeErrorSignature = (
  message: string,
  stack?: string | null,
): ErrorSignatureResult => {
  const template = normalize(message)
  const stackTemplate = stack ? normalize(stack).slice(0, 500) : ''
  const basis = stackTemplate ? `${template}\n${stackTemplate}` : template
  const normalizedHash = createHash('sha256').update(basis).digest('hex').slice(0, 40)
  return { normalizedHash, template, stackTemplate }
}
