/**
 * P2: Channel categories and ordering.
 * Covers: R-SERVER-6
 */
import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, getChannelNames } from '../helpers/server'
import { hardRefresh } from '../helpers/navigation'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P2: Channel categories and ordering', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Category Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Channel ordering converges across clients (R-SERVER-6)', async () => {
    // Create channels in a specific order
    await createChannel(alice.page, 'alpha-channel')
    await createChannel(alice.page, 'beta-channel')
    await createChannel(alice.page, 'gamma-channel')

    // Wait for channels to propagate
    await alice.page.waitForTimeout(3_000)

    // Check ordering on alice
    await selectServer(alice.page, 'Category Server')
    const aliceChannels = await getChannelNames(alice.page)

    // Check ordering on bob
    await selectServer(bob.page, 'Category Server')
    const bobChannels = await getChannelNames(bob.page)

    // Both should have the same channels
    expect(aliceChannels).toContain('alpha-channel')
    expect(aliceChannels).toContain('beta-channel')
    expect(aliceChannels).toContain('gamma-channel')
    expect(bobChannels).toContain('alpha-channel')
    expect(bobChannels).toContain('beta-channel')
    expect(bobChannels).toContain('gamma-channel')

    // Ordering should match
    const aliceFiltered = aliceChannels.filter(c =>
      ['alpha-channel', 'beta-channel', 'gamma-channel'].includes(c)
    )
    const bobFiltered = bobChannels.filter(c =>
      ['alpha-channel', 'beta-channel', 'gamma-channel'].includes(c)
    )
    expect(aliceFiltered).toEqual(bobFiltered)

    // Refresh should not scramble ordering
    await hardRefresh(alice.page)
    await selectServer(alice.page, 'Category Server')
    const aliceAfterRefresh = await getChannelNames(alice.page)
    const aliceFilteredAfter = aliceAfterRefresh.filter(c =>
      ['alpha-channel', 'beta-channel', 'gamma-channel'].includes(c)
    )
    expect(aliceFilteredAfter).toEqual(aliceFiltered)
  })
})
