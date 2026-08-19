import { expect, test, type Page } from '@playwright/test'

const hostUrl = process.env.DSH_HOST_URL ?? 'http://127.0.0.1:3191'
const guestUrl = process.env.DSH_GUEST_URL ?? 'http://127.0.0.1:3192'

async function live(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

async function openOverlay(page: Page) {
  if (!page.url() || page.url() === 'about:blank') {
    throw new Error('page has no DSH url; goto host/guest first')
  }
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count()) await notice.evaluate((el) => (el as HTMLButtonElement).click())
  const launcher = page.getByRole('button', { name: /Colosseum|^AC$/ })
  await expect(launcher).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
  await launcher.evaluate((el) => (el as HTMLButtonElement).click())
  await expect(page.getByRole('dialog', { name: 'Agent Colosseum' })).toBeVisible({ timeout: 10_000 })
  const ack = page.getByRole('button', { name: /I understand/ })
  if (await ack.count()) await ack.evaluate((el) => (el as HTMLButtonElement).click())
  await expect(page.getByRole('heading', { name: /Lobby|Room|Privacy|Grant inventory|Hand|Result|Relay/ })).toBeVisible({ timeout: 10_000 })
}

async function goLobby(page: Page) {
  const leave = page.getByRole('button', { name: 'Leave' })
  if (await leave.count()) await leave.evaluate((el) => (el as HTMLButtonElement).click())
  const lobbyNav = page.getByRole('button', { name: 'lobby', exact: true })
  if (await lobbyNav.count()) await lobbyNav.evaluate((el) => (el as HTMLButtonElement).click())
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible({ timeout: 10_000 })
}

async function waitEither(host: Page, guest: Page, name: RegExp, timeout = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await host.getByRole('heading', { name }).count() || await guest.getByRole('heading', { name }).count()) return
    await host.waitForTimeout(250)
  }
  throw new Error(`missing heading ${name}`)
}

test('two real DSH web profiles complete friend-room Grant redeem', async ({ browser }) => {
  test.setTimeout(180_000)
  if (!(await live(hostUrl)) || !(await live(guestUrl))) {
    if (process.env.CI === 'true' && process.env.ARENA_E2E !== '1') test.skip()
    throw new Error(`both DSH web profiles must be up (${hostUrl}, ${guestUrl})`)
  }

  const hostCtx = await browser.newContext()
  const guestCtx = await browser.newContext()
  const host = await hostCtx.newPage()
  const guest = await guestCtx.newPage()
  await host.goto(hostUrl, { waitUntil: 'domcontentloaded' })
  await guest.goto(guestUrl, { waitUntil: 'domcontentloaded' })

  await openOverlay(host)
  await openOverlay(guest)
  await goLobby(host)
  await goLobby(guest)
  await expect(host.getByRole('dialog', { name: 'Agent Colosseum' }).getByText('ready', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(guest.getByRole('dialog', { name: 'Agent Colosseum' }).getByText('ready', { exact: true })).toBeVisible({ timeout: 20_000 })

  await host.getByLabel('Left').selectOption({ value: 'openai-compatible:fold-a' })
  await guest.getByLabel('Left').selectOption({ value: 'openai-compatible:fold-b' })

  await host.getByRole('button', { name: 'Create room' }).evaluate((el) => (el as HTMLButtonElement).click())
  const hostRoom = host.getByRole('heading', { name: /^Room [A-Z0-9]{6}$/ })
  await expect(hostRoom).toBeVisible({ timeout: 15_000 })
  const roomCode = ((await hostRoom.innerText()).match(/[A-Z0-9]{6}/) ?? [])[0]
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)

  const codeBox = guest.getByLabel('Room code')
  await codeBox.click()
  await codeBox.fill('')
  await codeBox.pressSequentially(roomCode, { delay: 20 })
  await expect(codeBox).toHaveValue(roomCode)
  await guest.getByRole('button', { name: 'Join' }).evaluate((el) => (el as HTMLButtonElement).click())
  await expect(guest.getByRole('heading', { name: new RegExp(`^Room ${roomCode}$`) })).toBeVisible({ timeout: 20_000 })

  await host.getByRole('button', { name: 'Accept' }).evaluate((el) => (el as HTMLButtonElement).click())
  await guest.getByRole('button', { name: 'Accept' }).evaluate((el) => (el as HTMLButtonElement).click())

  await waitEither(host, guest, /^Hand |^Result$|^Grant inventory$/)
  await host.getByRole('button', { name: 'table', exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await expect(host.getByRole('heading', { name: /^Hand / })).toBeVisible({ timeout: 5_000 })
  await host.getByRole('button', { name: 'result', exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await expect(host.getByRole('heading', { name: 'Result' })).toBeVisible({ timeout: 5_000 })
  await expect(host.getByText(/chip_lead|bust|forfeit/i)).toBeVisible()

  await host.getByRole('button', { name: 'grants', exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await guest.getByRole('button', { name: 'grants', exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await expect(host.getByRole('heading', { name: 'Grant inventory' })).toBeVisible()
  const hostHasGrant = await host.getByText(/left/).count()
  const guestHasGrant = await guest.getByText(/left/).count()
  expect(hostHasGrant + guestHasGrant).toBeGreaterThan(0)

  const hostStream = host.getByRole('button', { name: 'Stream grant' })
  const guestStream = guest.getByRole('button', { name: 'Stream grant' })
  const winner = await hostStream.count() > 0 ? host : guest
  const stream = winner.getByRole('button', { name: 'Stream grant' }).first()
  await expect(stream).toBeVisible()
  await stream.evaluate((el) => (el as HTMLButtonElement).click())
  await expect.poll(async () => winner.getByRole('dialog', { name: 'Agent Colosseum' }).innerText(), { timeout: 20_000 })
    .toMatch(/reward-ok|completed| [0-9] left/i)
  const after = await winner.getByRole('dialog', { name: 'Agent Colosseum' }).innerText()
  expect(after).toMatch(/reward-ok|completed|[0-9] left/)
  expect(after).not.toMatch(/10 left/)

  await hostCtx.close()
  await guestCtx.close()
})
