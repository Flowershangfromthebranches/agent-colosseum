import { expect, test } from '@playwright/test'

const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3191'

test('DSH web serves the Agent Colosseum overlay', async ({ page }) => {
  await page.goto(base, { waitUntil: 'networkidle' })
  const boot = await page.locator('script').first().innerHTML()
  expect(boot).toContain('"id":"agent-colosseum"')
  expect(boot).toContain('/plugins/agent-colosseum/client.js')

  const launcher = page.getByRole('button', { name: /Colosseum|^AC$/ })
  await expect(launcher).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
  await launcher.evaluate((el) => (el as HTMLButtonElement).click())
  await expect(page.getByRole('dialog', { name: 'Agent Colosseum' })).toBeVisible({ timeout: 10_000 })
  const ack = page.getByRole('button', { name: /I understand/ })
  if (await ack.count()) await ack.evaluate((el) => (el as HTMLButtonElement).click())
  await expect(page.getByRole('heading', { name: /Privacy|Lobby|Room|Grant inventory|Relay|Result|Hand/ })).toBeVisible({ timeout: 10_000 })
  for (const view of ['lobby', 'room', 'table', 'result', 'grants', 'relay'] as const) {
    const nav = page.getByRole('button', { name: view, exact: true })
    if (await nav.count()) await nav.evaluate((el) => (el as HTMLButtonElement).click())
  }
})
