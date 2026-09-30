import type { DefaultTheme } from 'vitepress'

const LABEL = /^\d{4}-\d{2}-\d{2}$/

export const MENU_SIZE = 8

const label = (value: string, source: string): string => {
  if (!LABEL.test(value))
    throw new Error(`${source} holds "${value}", which is not a YYYY-MM-DD label`)
  return value
}

export const siteUrl = (): string => {
  const raw = process.env.DOCS_SITE?.trim() || 'https://akogut.github.io/flakemetry/'
  return raw.endsWith('/') ? raw : `${raw}/`
}

export const snapshotVersion = (): string | null => {
  const raw = process.env.DOCS_VERSION?.trim()
  return raw ? label(raw, 'DOCS_VERSION') : null
}

export const publishedSnapshots = (): string[] =>
  [
    ...new Set(
      (process.env.DOCS_SNAPSHOTS ?? '')
        .split(/[\s,]+/)
        .filter((value) => value !== '')
        .map((value) => label(value, 'DOCS_SNAPSHOTS')),
    ),
  ]
    .sort()
    .reverse()

export const versionNav = (
  version: string | null,
  snapshots: readonly string[],
  site: string,
): DefaultTheme.NavItem[] => {
  if (version) {
    return [
      {
        text: version,
        items: [
          { text: 'Latest', link: site, target: '_self', noIcon: true },
          { text: 'All versions', link: `${site}versions`, target: '_self', noIcon: true },
        ],
      },
    ]
  }
  if (snapshots.length === 0) return []
  return [
    {
      text: 'Latest',
      items: [
        { text: 'Latest', link: '/' },
        ...snapshots
          .slice(0, MENU_SIZE)
          .map((snapshot) => ({ text: snapshot, link: `/v/${snapshot}/`, target: '_self' })),
        { text: 'All versions', link: '/versions' },
      ],
    },
  ]
}
