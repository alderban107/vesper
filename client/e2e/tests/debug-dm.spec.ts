import { test, expect } from '@playwright/test'
import { saveRecoveryKey } from '../harness/state'
import { signup, createUserContext, type UserContext } from '../helpers/auth'
import { createDm, selectDm, sendDmMessage } from '../helpers/dm'
import { USERS, DM_MESSAGES } from '../fixtures/test-data'
import { getMlsDiagnostics, assertMlsBudget } from '../helpers/mls-diagnostics'
import { waitForMessage } from '../helpers/wait'

let alice: UserContext
let bob: UserContext

const DEBUG_USERS = {
  alice: {
    ...USERS.alice,
    username: `${USERS.alice.username}_debug`
  },
  bob: {
    ...USERS.bob,
    username: `${USERS.bob.username}_debug`
  }
} as const

test.describe('DM Debug', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(
      browser,
      'alice-debug',
      DEBUG_USERS.alice.username,
      DEBUG_USERS.alice.password
    )
    bob = await createUserContext(
      browser,
      'bob-debug',
      DEBUG_USERS.bob.username,
      DEBUG_USERS.bob.password
    )
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

  test('DM message exchange', async () => {
    test.setTimeout(60_000)

    // Inject MLS event interceptor for diagnostics
    for (const [name, user] of [['alice', alice], ['bob', bob]] as const) {
      user.page.on('console', msg => {
        if (msg.text().includes('[MLS]')) {
          console.log(`[${name}] ${msg.text()}`)
        }
      })
      await user.page.evaluate((userName) => {
        (window as any).__mlsEvents = []
        const origSend = WebSocket.prototype.send
        WebSocket.prototype.send = function(data: any) {
          try {
            const str = typeof data === 'string' ? data : ''
            if (str.includes('mls_') || str.includes('new_message')) {
              (window as any).__mlsEvents.push({
                t: Date.now(), user: userName,
                preview: str.substring(0, 200)
              })
            }
          } catch {}
          return origSend.call(this, data)
        }
      }, name)
    }

    await createDm(alice.page, DEBUG_USERS.bob.username)
    await sendDmMessage(alice.page, DM_MESSAGES.aliceToBob1)
    await selectDm(bob.page, DEBUG_USERS.alice.username)

    // Wait for Bob to receive and decrypt
    const bobDecrypted = await waitForMessage(
      bob.page,
      DM_MESSAGES.aliceToBob1,
      15_000
    ).then(() => true).catch(() => false)

    // Dump trace on failure for diagnostics
    if (!bobDecrypted) {
      const extractEvents = (events: any[]) => events?.map((e: any) => {
        try {
          const parsed = JSON.parse(e.preview?.padEnd(200, '"}]') || '[]')
          const eventName = Array.isArray(parsed) ? parsed[3] : 'unknown'
          return `${e.user} t+${((e.t - events[0]?.t) / 1000).toFixed(1)}s ${eventName}`
        } catch { return e.preview?.substring(0, 80) }
      })
      const aliceEvents = await alice.page.evaluate(() => (window as any).__mlsEvents)
      const bobEvents = await bob.page.evaluate(() => (window as any).__mlsEvents)
      console.log('Alice events:', JSON.stringify(extractEvents(aliceEvents), null, 2))
      console.log('Bob events:', JSON.stringify(extractEvents(bobEvents), null, 2))

      const bobMsgs = await bob.page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="message-row"]')).map(r =>
          r.querySelector('[data-testid="message-content"]')?.textContent ?? null
        ).filter(Boolean)
      )
      console.log('Bob messages:', JSON.stringify(bobMsgs))
    }

    expect(bobDecrypted).toBe(true)

    // --- MLS epoch budget assertion ---
    // A 2-user DM handshake: leader creates group (epoch 0), adds non-leader
    // (epoch 1). Message encrypted at epoch 1. No storms.
    const dmScopeId = await alice.page.evaluate(() => {
      const diag = (window as any).__mlsDiagnostics
      if (!diag) return null
      const scopes = diag.allScopes()
      // Find the DM scope (the one with a group creation)
      for (const [id, entry] of Object.entries(scopes) as [string, any][]) {
        if (entry.groupCreations > 0 || entry.welcomesProcessed > 0) return id
      }
      return null
    })

    if (dmScopeId) {
      // Leader (Alice or Bob — depends on UUID ordering)
      for (const [name, user] of [['alice', alice], ['bob', bob]] as const) {
        const diag = await getMlsDiagnostics(user.page, dmScopeId)
        if (diag) {
          // Epoch should be 1 (group created at 0, one member added → 1)
          assertMlsBudget(diag, { maxEpoch: 1 }, `${name} DM`)
          // At most 1 join request handled (leader adds non-leader once)
          assertMlsBudget(diag, { maxJoinRequestsHandled: 1 }, `${name} DM join handling`)
          // At most 1 group creation per user
          assertMlsBudget(diag, { maxGroupCreations: 1 }, `${name} DM group creation`)
          // At most 1 key package consumed per user
          assertMlsBudget(diag, { maxKeyPackagesConsumed: 1 }, `${name} DM key package consumption`)
        }
      }
    }
  })
})
