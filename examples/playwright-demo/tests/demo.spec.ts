import { expect, test } from '@playwright/test'

// A page that renders a "dashboard" after a random delay — enough to make a
// naive test occasionally lose a race. Fully offline; no external site.
const APP = `
  <button id="load">Load</button>
  <div id="panel"></div>
  <script>
    document.getElementById('load').addEventListener('click', () => {
      const delay = 50 + Math.random() * 400
      setTimeout(() => {
        document.getElementById('panel').textContent = 'ready'
      }, delay)
    })
  </script>
`

test.describe('checkout', () => {
  test('renders the total (stable)', async ({ page }) => {
    await page.setContent('<div id="total">42.00</div>')
    await expect(page.locator('#total')).toHaveText('42.00')
  })

  test('shows the panel after loading (flaky race)', async ({ page }) => {
    await page.setContent(APP)
    await page.locator('#load').click()
    // Deliberately too short a timeout — the panel usually, but not always,
    // renders in time. This is a real timing race, the hardest kind of flake.
    await expect(page.locator('#panel')).toHaveText('ready', { timeout: 250 })
  })
})

test.describe('auth', () => {
  test('logs in (flaky on first attempt)', async ({ page }, testInfo) => {
    await page.setContent('<div id="status">ok</div>')
    // Fails the first attempt, passes on retry — Playwright marks it "flaky",
    // and Flakemetry records both attempts on the same commit.
    expect(testInfo.retry, 'transient auth hiccup on first attempt').toBeGreaterThan(0)
    await expect(page.locator('#status')).toHaveText('ok')
  })
})

test.describe('orders', () => {
  test('creates an order (regression)', async ({ page }) => {
    await page.setContent('<div id="response">422</div>')
    // A stable, reproducible failure — the kind AI RCA explains.
    await expect(
      page.locator('#response'),
      'orders API returned 422 Unprocessable Entity',
    ).toHaveText('201')
  })
})
