export const PROJECTS = [
  {
    slug: 'playwright',
    name: 'Playwright e-commerce suite',
    repo: 'AKogut/playwright-ecommerce-framework',
    summary: 'Web tests against SauceDemo on Chromium, Firefox and WebKit.',
  },
  {
    slug: 'restful-booker',
    name: 'Restful Booker API suite',
    repo: 'AKogut/restful-booker-api-testing',
    summary: 'API tests against a hosted demo platform and a local copy of it in Docker.',
  },
  {
    slug: 'mobile',
    name: 'Mobile task manager suite',
    repo: 'AKogut/mobile-task-manager-automation',
    summary: 'The same test cases on Appium for Android and iOS, XCUITest and Espresso.',
  },
  {
    slug: 'flakemetry',
    name: 'Flakemetry itself',
    repo: 'AKogut/flakemetry',
    summary: 'The test suite of this tool, against a real database.',
  },
]

export const MOBILE_RUNNERS = ['appium-android', 'appium-ios', 'xcuitest', 'espresso']

export const MOBILE_JOBS = [
  { match: 'Appium / Android', variant: 'appium-android' },
  { match: 'Appium / iOS', variant: 'appium-ios' },
  { match: 'XCUITest /', variant: 'xcuitest' },
  { match: 'Espresso /', variant: 'espresso' },
]
