import { type DefaultTheme, defineConfigWithTheme } from 'vitepress'

import { publishedSnapshots, siteUrl, snapshotVersion, versionNav } from './versions'

export interface ThemeConfig extends DefaultTheme.Config {
  docsVersion: string | null
  latestUrl: string
  snapshots: string[]
}

const repo = 'https://github.com/AKogut/flakemetry'
const site = siteUrl()
const version = snapshotVersion()
const snapshots = version ? [] : publishedSnapshots()
const base = `${new URL(site).pathname}${version ? `v/${version}/` : ''}`

export default defineConfigWithTheme<ThemeConfig>({
  title: 'Flakemetry',
  description:
    'OpenTelemetry-native test intelligence — treat every test run as a trace, not a report.',
  lang: 'en-US',
  base,
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: version ? ['README.md', 'versions.md'] : ['README.md'],
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  head: [
    ['meta', { name: 'theme-color', content: '#5319e7' }],
    ['meta', { property: 'og:title', content: 'Flakemetry Documentation' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'OpenTelemetry-native test intelligence: explainable flaky detection and AI root-cause.',
      },
    ],
    ...(version
      ? [
          ['meta', { name: 'robots', content: 'noindex' }] as [string, Record<string, string>],
          ['style', {}, ':root { --vp-layout-top-height: 40px; }'] as [
            string,
            Record<string, string>,
            string,
          ],
        ]
      : []),
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Concepts', link: '/concepts/test-identity' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Contributing', link: '/contributing/development' },
      { text: 'Roadmap', link: 'https://github.com/users/AKogut/projects/14' },
      ...versionNav(version, snapshots, site),
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Self-hosting', link: '/guide/self-hosting' },
            { text: 'Integrating a project', link: '/guide/integrate' },
            { text: 'Your team', link: '/guide/team' },
            { text: 'Your first insight', link: '/guide/first-insight' },
            { text: 'Cost of flakiness', link: '/guide/cost' },
            { text: 'Usage and limits', link: '/guide/usage-and-limits' },
            { text: 'Tracker issues', link: '/guide/tracker' },
            { text: 'Which change caused it', link: '/guide/bisect' },
            { text: 'Health badges', link: '/guide/badges' },
            { text: 'Webhooks', link: '/guide/webhooks' },
            { text: 'Plugins', link: '/guide/plugins' },
          ],
        },
        {
          text: 'Sending test data',
          items: [
            { text: 'Reporters (Playwright · Vitest · Jest)', link: '/guide/reporters' },
            { text: 'Any runner via JUnit XML', link: '/guide/junit' },
            { text: 'GitHub Action', link: '/guide/github-action' },
            { text: 'CLI', link: '/guide/cli' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Test identity', link: '/concepts/test-identity' },
            { text: 'Flaky scoring', link: '/concepts/flaky-scoring' },
            { text: 'AI root-cause', link: '/concepts/ai-rca' },
            { text: 'OTel test conventions', link: '/concepts/otel-conventions' },
            { text: 'Architecture', link: '/concepts/architecture' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'API reference', link: '/reference/api' },
            { text: 'Data governance', link: '/reference/data-governance' },
            { text: 'Threat model', link: '/reference/threat-model' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [{ text: 'Development guide', link: '/contributing/development' }],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: version
      ? undefined
      : {
          pattern: `${repo}/edit/main/apps/docs/:path`,
          text: 'Edit this page on GitHub',
        },
    docsVersion: version,
    latestUrl: site,
    snapshots,
    search: { provider: 'local' },
    footer: {
      message: 'MIT licensed',
      copyright: 'Copyright © Andrii Kohut',
    },
    outline: 'deep',
    externalLinkIcon: true,
  },
  sitemap: version ? undefined : { hostname: site },
})
