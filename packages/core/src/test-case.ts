export const TEST_CASE_ID_PATTERN =
  /(?:(?<![A-Z0-9])TC|(?<![A-Za-z0-9])tc)[-_][A-Za-z]+[-_]\d+(?![a-z0-9])/

export const extractTestCaseId = (
  title: string,
  pattern: RegExp = TEST_CASE_ID_PATTERN,
): string | null => {
  const firstMatchOnly = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  const match = firstMatchOnly.exec(title)
  return match ? match[0].toUpperCase().replace(/_/g, '-') : null
}
