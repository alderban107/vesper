import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { createUserContext, signup } from '../helpers/auth'
import { createDm, selectDm } from '../helpers/dm'
import { createServer, selectChannel, selectServer } from '../helpers/server'
import { waitForChannelEncryptionReady, waitForDmEncryptionReady } from '../helpers/wait'

const password = 'attachment-e2e-password'

async function stageTextAttachment(page: Page, name: string, content: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach file' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(content)
  })
  await expect(page.getByTestId('staged-file')).toBeVisible()
}

async function stageTextAttachments(
  page: Page,
  files: Array<{ name: string; content: string }>
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach file' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(files.map((file) => ({
    name: file.name,
    mimeType: 'text/plain',
    buffer: Buffer.from(file.content)
  })))
  await expect(page.getByTestId('staged-file')).toHaveCount(files.length)
}

async function sendStagedAttachment(page: Page): Promise<void> {
  const sendButton = page.getByRole('button', { name: 'Send message' })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
}

function isNewMessageFrame(message: string | Buffer): boolean {
  try {
    const frame = JSON.parse(typeof message === 'string' ? message : message.toString())
    return Array.isArray(frame) && frame[3] === 'new_message'
  } catch {
    return false
  }
}

async function expectAttachmentDownload(page: Page, name: string, content: string): Promise<void> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('attachment').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(name)

  const path = await download.path()
  expect(path).not.toBeNull()
  expect(await readFile(path!, 'utf8')).toBe(content)
}

test('uploads, sends, and downloads an encrypted channel attachment', async ({ browser }) => {
  const suffix = Date.now()
  const user = await createUserContext(
    browser,
    `attachment-channel-${suffix}`,
    `attachment_channel_${suffix}`,
    password
  )
  const serverName = `Attachment server ${suffix}`
  const fileName = 'channel-attachment-smoke.txt'
  const fileContent = 'channel attachment smoke payload'

  await signup(user)
  await createServer(user.page, serverName)
  await selectServer(user.page, serverName)
  await selectChannel(user.page, 'general')
  await waitForChannelEncryptionReady(user.page)

  await stageTextAttachment(user.page, fileName, fileContent)
  await sendStagedAttachment(user.page)

  const attachment = user.page.getByTestId('attachment')
  await expect(attachment).toBeVisible({ timeout: 15_000 })
  await expect(attachment).toContainText(fileName)
  await expectAttachmentDownload(user.page, fileName, fileContent)
  await user.context.close()
})

test('retries an encrypted attachment download after a transient server failure', async ({ browser }) => {
  const suffix = Date.now()
  const user = await createUserContext(
    browser,
    `attachment-download-retry-${suffix}`,
    `att_download_retry_${suffix}`,
    password
  )
  const serverName = `Attachment download retry ${suffix}`
  const fileName = 'download-retry.txt'
  const fileContent = 'download retry payload'

  await signup(user)
  await createServer(user.page, serverName)
  await selectServer(user.page, serverName)
  await selectChannel(user.page, 'general')
  await waitForChannelEncryptionReady(user.page)
  await stageTextAttachment(user.page, fileName, fileContent)
  await sendStagedAttachment(user.page)

  const attachment = user.page.getByTestId('attachment')
  await expect(attachment).toContainText(fileName, { timeout: 15_000 })

  let failDownloads = true
  await user.page.route('**/api/v1/attachments/*', async (route) => {
    if (failDownloads && route.request().method() === 'GET') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporarily unavailable' })
      })
      return
    }

    await route.continue()
  })

  await attachment.click()
  await expect(user.page.getByText('Could not download file. Check your connection.')).toBeVisible()
  failDownloads = false

  const downloadPromise = user.page.waitForEvent('download')
  await user.page.getByTestId('attachment').getByRole('button', { name: 'Retry', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(fileName)
  const path = await download.path()
  expect(path).not.toBeNull()
  expect(await readFile(path!, 'utf8')).toBe(fileContent)

  await user.context.close()
})

test('keeps an attachment sent after acknowledgement when the sender websocket echo is dropped', async ({ browser }) => {
  const suffix = Date.now()
  const user = await createUserContext(
    browser,
    `attachment-dropped-echo-${suffix}`,
    `att_echo_${suffix}`,
    password
  )
  let dropSenderEcho = false
  let droppedNewMessageFrames = 0

  await user.context.routeWebSocket(/\/socket\/websocket/, (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      if (dropSenderEcho && isNewMessageFrame(message)) {
        droppedNewMessageFrames += 1
        return
      }
      socket.send(message)
    })
  })

  const serverName = `Attachment dropped echo ${suffix}`
  const fileName = 'dropped-sender-echo.txt'

  await signup(user)
  await createServer(user.page, serverName)
  await selectServer(user.page, serverName)
  await selectChannel(user.page, 'general')
  await waitForChannelEncryptionReady(user.page)

  dropSenderEcho = true
  await stageTextAttachment(user.page, fileName, 'acknowledged without echo')
  await sendStagedAttachment(user.page)

  const sentRow = user.page.getByTestId('message-row').filter({ hasText: fileName })
  await expect(sentRow).toBeVisible({ timeout: 15_000 })
  await expect(sentRow).not.toHaveClass(/vesper-message-row-(sending|failed)/)
  await expect.poll(() => droppedNewMessageFrames).toBeGreaterThan(0)
  await user.context.close()
})

test('keeps a staged attachment and shows an actionable error when upload fails', async ({ browser }) => {
  const suffix = Date.now()
  const user = await createUserContext(
    browser,
    `attachment-upload-failure-${suffix}`,
    `att_fail_${suffix}`,
    password
  )
  const serverName = `Attachment upload failure ${suffix}`
  const fileName = 'upload-failure.txt'

  await signup(user)
  await createServer(user.page, serverName)
  await selectServer(user.page, serverName)
  await selectChannel(user.page, 'general')
  await waitForChannelEncryptionReady(user.page)
  await user.page.route(/\/api\/v1\/attachments(?:\/stream)?$/, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'temporarily unavailable' })
    })
  })

  await stageTextAttachment(user.page, fileName, 'upload must fail')
  await sendStagedAttachment(user.page)

  await expect(user.page.getByText('This file could not be uploaded. Check your connection and try again.')).toBeVisible()
  await expect(user.page.getByText('The staged file is still available to retry.')).toBeVisible()
  await expect(user.page.getByTestId('staged-file')).toContainText(fileName)
  await expect(user.page.getByTestId('staged-file-status')).toHaveText('Upload failed. Retry.')
  await expect(user.page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expect(user.page.getByTestId('message-row').filter({ hasText: fileName })).toHaveCount(0)
  await user.context.close()
})

test('retries only the unsent remainder after a multi-file partial failure', async ({ browser }) => {
  const suffix = Date.now()
  const user = await createUserContext(
    browser,
    `attachment-partial-${suffix}`,
    `att_partial_${suffix}`,
    password
  )
  const serverName = `Attachment partial ${suffix}`
  const firstFile = { name: 'partial-first.txt', content: 'first attachment payload' }
  const secondFile = { name: 'partial-second.txt', content: 'second attachment payload' }
  let uploadCount = 0
  let failSecondUpload = true

  await signup(user)
  await createServer(user.page, serverName)
  await selectServer(user.page, serverName)
  await selectChannel(user.page, 'general')
  await waitForChannelEncryptionReady(user.page)
  await user.page.route(/\/api\/v1\/attachments(?:\/stream)?$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }

    uploadCount += 1
    if (failSecondUpload && uploadCount === 2) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporarily unavailable' })
      })
      return
    }

    await route.continue()
  })

  await stageTextAttachments(user.page, [firstFile, secondFile])
  await sendStagedAttachment(user.page)

  await expect(user.page.getByTestId('message-row').filter({ hasText: firstFile.name })).toHaveCount(1)
  await expect(user.page.getByTestId('message-row').filter({ hasText: secondFile.name })).toHaveCount(0)
  await expect(user.page.getByTestId('staged-file')).toHaveCount(1)
  await expect(user.page.getByTestId('staged-file')).toContainText(secondFile.name)
  await expect(user.page.getByTestId('staged-file-status')).toHaveText('Upload failed. Retry.')

  failSecondUpload = false
  await sendStagedAttachment(user.page)

  await expect(user.page.getByTestId('message-row').filter({ hasText: firstFile.name })).toHaveCount(1)
  await expect(user.page.getByTestId('message-row').filter({ hasText: secondFile.name })).toHaveCount(1)
  await expect(user.page.getByTestId('staged-file')).toHaveCount(0)
  await user.context.close()
})

test('delivers the first encrypted DM attachment to both participants', async ({ browser }) => {
  const suffix = Date.now()
  const alice = await createUserContext(
    browser,
    `attachment-dm-alice-${suffix}`,
    `attachment_alice_${suffix}`,
    password
  )
  const bob = await createUserContext(
    browser,
    `attachment-dm-bob-${suffix}`,
    `attachment_bob_${suffix}`,
    password
  )
  const fileName = 'dm-attachment-smoke.txt'
  const fileContent = 'dm attachment smoke payload'

  await signup(alice)
  await signup(bob)
  await createDm(alice.page, bob.username)
  await selectDm(bob.page, alice.username)
  await waitForDmEncryptionReady(alice.page)

  await stageTextAttachment(alice.page, fileName, fileContent)
  await sendStagedAttachment(alice.page)

  const aliceAttachment = alice.page.getByTestId('attachment')
  const bobAttachment = bob.page.getByTestId('attachment')
  await expect(aliceAttachment).toBeVisible({ timeout: 15_000 })
  await expect(bobAttachment).toBeVisible({ timeout: 15_000 })
  await expect(bobAttachment).toContainText(fileName)
  await expectAttachmentDownload(bob.page, fileName, fileContent)
  await Promise.all([alice.context.close(), bob.context.close()])
})
