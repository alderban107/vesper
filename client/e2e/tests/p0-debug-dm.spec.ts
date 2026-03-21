import { test } from '@playwright/test'
import { saveRecoveryKey, readRunState } from '../harness/state'
import { signup, createUserContext, type UserContext } from '../helpers/auth'
import { USERS, DM_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('DM Debug', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('signup', async () => {
    await signup(alice)
    saveRecoveryKey(alice.username, alice.recoveryKey!)
    await signup(bob)
    saveRecoveryKey(bob.username, bob.recoveryKey!)
  })

  test('trace MLS events', async () => {
    test.setTimeout(60_000)

    // Inject MLS event interceptor into both pages BEFORE any DM activity
    for (const [name, user] of [['alice', alice], ['bob', bob]] as const) {
      await user.page.evaluate((userName) => {
        (window as any).__mlsEvents = [];
        // Monkey-patch Phoenix channel push to log MLS events
        const origPush = (window as any).WebSocket.prototype.send
        const ws = (window as any).WebSocket
        ;(window as any).__origSend = origPush
        ws.prototype.send = function(data: any) {
          try {
            const str = typeof data === 'string' ? data : ''
            if (str.includes('mls_') || str.includes('new_message')) {
              (window as any).__mlsEvents.push({
                dir: 'out',
                t: Date.now(),
                preview: str.substring(0, 200),
                user: userName
              })
            }
          } catch {}
          return origPush.call(this, data)
        }

        // Also intercept incoming messages
        const origAddEventListener = EventTarget.prototype.addEventListener
        // Can't easily intercept WS onmessage, but we can use a MutationObserver
        // to detect DOM changes as a proxy for event processing
      }, name)
    }

    // Create DM
    await alice.page.locator('[data-testid="sidebar"] button[title="Direct Messages"]').click()
    await alice.page.waitForSelector('text=Direct Messages', { timeout: 5_000 })
    await alice.page.click('[data-testid="sidebar"] button[title="New Message"]')
    await alice.page.waitForSelector('text=New Message', { timeout: 5_000 })
    await alice.page.locator('input[placeholder="Enter exact username"]').fill(USERS.bob.username)
    await alice.page.click('button:has-text("Start Chat")')
    await alice.page.waitForSelector('text=New Message', { state: 'hidden', timeout: 5_000 })
    await alice.page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })
    console.log('--- DM created ---')

    // Check Alice's outgoing MLS events
    const aliceEvents1 = await alice.page.evaluate(() => (window as any).__mlsEvents)
    console.log('Alice MLS events after DM create:', JSON.stringify(aliceEvents1, null, 2))

    // Bob opens DM
    await bob.page.locator('[data-testid="sidebar"] button[title="Direct Messages"]').click()
    await bob.page.waitForSelector('text=Direct Messages', { timeout: 5_000 })
    await bob.page.waitForFunction((name: string) => {
      return Array.from(document.querySelectorAll('[data-testid="dm-row"]')).some(el =>
        el.textContent?.includes(name)
      )
    }, USERS.alice.username, { timeout: 10_000 })
    const dmRows = bob.page.getByTestId('dm-row')
    for (let i = 0; i < await dmRows.count(); i++) {
      if ((await dmRows.nth(i).textContent())?.includes(USERS.alice.username)) {
        await dmRows.nth(i).click()
        break
      }
    }
    await bob.page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })
    console.log('--- Bob in DM ---')

    // Check Bob's outgoing MLS events
    const bobEvents1 = await bob.page.evaluate(() => (window as any).__mlsEvents)
    console.log('Bob MLS events after DM open:', JSON.stringify(bobEvents1, null, 2))

    // Wait 3s for MLS handshake
    await alice.page.waitForTimeout(3000)
    
    const aliceEvents2 = await alice.page.evaluate(() => (window as any).__mlsEvents)
    const bobEvents2 = await bob.page.evaluate(() => (window as any).__mlsEvents)
    console.log('Alice MLS events after 3s:', JSON.stringify(aliceEvents2, null, 2))
    console.log('Bob MLS events after 3s:', JSON.stringify(bobEvents2, null, 2))

    // Alice sends
    const textarea = alice.page.locator('.vesper-composer-textarea')
    await textarea.fill(DM_MESSAGES.aliceToBob1)
    await textarea.press('Enter')
    console.log('--- Alice sent ---')

    await alice.page.waitForTimeout(3000)
    const aliceEvents3 = await alice.page.evaluate(() => (window as any).__mlsEvents)
    const bobEvents3 = await bob.page.evaluate(() => (window as any).__mlsEvents)
    console.log('Alice MLS events after send:', JSON.stringify(aliceEvents3, null, 2))
    console.log('Bob MLS events after send:', JSON.stringify(bobEvents3, null, 2))

    const bobMsgs = await bob.page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="message-row"]')).map(r => {
        const c = r.querySelector('[data-testid="message-content"]')
        return c?.textContent ?? null
      }).filter(Boolean)
    })
    console.log('Bob messages:', JSON.stringify(bobMsgs))
  })
})
