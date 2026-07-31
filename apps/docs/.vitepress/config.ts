import { defineConfig } from 'vitepress'

const repo = 'https://github.com/AKogut/flakemetry'

export default defineConfig({
  title: 'Flakemetry',
  description:
    'OpenTelemetry-native test intelligence — treat every test run as a trace, not a report.',
  lang: 'en-US',
  base: '/flakemetry/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md'],
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
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Concepts', link: '/concepts/test-identity' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Roadmap', link: 'https://github.com/users/AKogut/projects/14' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Self-hosting', link: '/guide/self-hosting' },
            { text: 'Your first insight', link: '/guide/first-insight' },
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
            { text: 'Threat model', link: '/reference/threat-model' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/apps/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    footer: {
      message: 'MIT licensed',
      copyright: 'Copyright © Andrii Kohut',
    },
    outline: 'deep',
    externalLinkIcon: true,
  },
  sitemap: { hostname: 'https://akogut.github.io/flakemetry/' },
})
