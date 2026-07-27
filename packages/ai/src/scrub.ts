export interface ScrubbableError {
  type?: string | null
  message: string
  stack?: string | null
}

type Rule = { pattern: RegExp; replace: string }

const RULES: Rule[] = [
  { pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/g, replace: '//[REDACTED]@' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED_AWS_KEY]' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: '[REDACTED_TOKEN]' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replace: '[REDACTED_TOKEN]' },
  {
    pattern: /\b(?:fmk|ghp|gho|ghs|xox[baprs])[_-][A-Za-z0-9]{16,}\b/g,
    replace: '[REDACTED_TOKEN]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: '[REDACTED_JWT]',
  },
  { pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, replace: 'Bearer [REDACTED_TOKEN]' },
  {
    pattern:
      /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,;)}]+)/gi,
    replace: '$1[REDACTED]',
  },
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: '[REDACTED_EMAIL]',
  },
  {
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    replace: '[REDACTED_IP]',
  },
  { pattern: /(\/(?:Users|home)\/)[^/\s]+/g, replace: '$1[REDACTED]' },
  { pattern: /([A-Za-z]:\\Users\\)[^\\\s]+/g, replace: '$1[REDACTED]' },
]

export const scrubText = (input: string): string =>
  RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replace), input)

export const scrubError = (error: ScrubbableError): ScrubbableError => ({
  type: error.type ?? null,
  message: scrubText(error.message),
  stack: error.stack == null ? error.stack : scrubText(error.stack),
})
