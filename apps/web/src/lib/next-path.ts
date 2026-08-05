// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Where to send someone after they sign in, taken from a query parameter — so it is
 * attacker-supplied by construction. Anything that is not a plain path on this origin
 * becomes the fallback: `//evil.example` and `/\evil.example` are both read as
 * protocol-relative URLs by browsers, which would turn the sign-in page into an open
 * redirect that arrives wearing our domain.
 */
export const safeNextPath = (value: string | null | undefined, fallback = '/'): string => {
  if (!value) return fallback
  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (CONTROL.test(value)) return fallback
  return value
}
