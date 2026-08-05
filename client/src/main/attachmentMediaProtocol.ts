import { randomBytes } from 'node:crypto'
import { ipcMain, protocol, type WebContents } from 'electron'
import {
  assertAttachmentEncryptionV2,
  decryptAttachmentStreamV2,
  planAttachmentPlaintextRange,
  type AttachmentEncryptionV2
} from '@vesper/sdk/crypto'

export const ATTACHMENT_MEDIA_SCHEME = 'vesper-attachment'

interface AttachmentMediaRegistration {
  attachmentId: string
  serverUrl: string
  accessToken: string
  contentType: string
  plaintextSize: number
  encryption: AttachmentEncryptionV2
}

interface AttachmentMediaCapability extends AttachmentMediaRegistration {
  ownerWebContentsId: number
  activeRequests: Set<AbortController>
}

interface PlaintextRange {
  start: number
  endInclusive: number
}

type RefreshAccessToken = (serverUrl: string) => Promise<string | null>

const capabilities = new Map<string, AttachmentMediaCapability>()

export function registerAttachmentMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function validRegistration(value: unknown): AttachmentMediaRegistration | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AttachmentMediaRegistration>
  if (
    typeof candidate.attachmentId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(candidate.attachmentId) ||
    typeof candidate.serverUrl !== 'string' ||
    typeof candidate.accessToken !== 'string' ||
    candidate.accessToken.length === 0 ||
    candidate.accessToken.length > 8192 ||
    typeof candidate.contentType !== 'string' ||
    candidate.contentType.length === 0 ||
    candidate.contentType.length > 255 ||
    !Number.isSafeInteger(candidate.plaintextSize) ||
    (candidate.plaintextSize ?? -1) < 0
  ) {
    return null
  }

  let serverUrl: URL
  try {
    serverUrl = new URL(candidate.serverUrl)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password) {
    return null
  }

  try {
    return {
      attachmentId: candidate.attachmentId,
      serverUrl: serverUrl.origin,
      accessToken: candidate.accessToken,
      contentType: candidate.contentType,
      plaintextSize: candidate.plaintextSize!,
      encryption: assertAttachmentEncryptionV2(candidate.encryption)
    }
  } catch {
    return null
  }
}

export function parseAttachmentMediaRange(
  value: string | null,
  size: number
): PlaintextRange | null | 'invalid' {
  if (value === null) return null
  if (!value.startsWith('bytes=') || value.includes(',')) return 'invalid'
  const match = /^(\d*)-(\d*)$/.exec(value.slice('bytes='.length))
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return 'invalid'

  if (match[1] === '') {
    const suffix = Number.parseInt(match[2]!, 10)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(size - suffix, 0), endInclusive: size - 1 }
  }

  const start = Number.parseInt(match[1]!, 10)
  const requestedEnd = match[2] === '' ? size - 1 : Number.parseInt(match[2]!, 10)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return 'invalid'
  }
  return { start, endInclusive: Math.min(requestedEnd, size - 1) }
}

export function sliceAttachmentPlaintextStream(
  source: ReadableStream<Uint8Array>,
  skip: number,
  length: number
): ReadableStream<Uint8Array> {
  if (length === 0) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of source) {
            if (chunk.byteLength !== 0) throw new Error('unexpected plaintext for empty attachment')
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      }
    })
  }

  const reader = source.getReader()
  let remainingSkip = skip
  let remainingLength = length

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (remainingLength > 0) {
          const next = await reader.read()
          if (next.done) throw new Error('attachment plaintext stream ended early')
          let chunk = next.value

          if (remainingSkip >= chunk.byteLength) {
            remainingSkip -= chunk.byteLength
            continue
          }
          if (remainingSkip > 0) {
            chunk = chunk.subarray(remainingSkip)
            remainingSkip = 0
          }

          const take = Math.min(remainingLength, chunk.byteLength)
          controller.enqueue(chunk.subarray(0, take))
          remainingLength -= take
          if (remainingLength === 0) {
            await reader.cancel('requested plaintext range complete')
            reader.releaseLock()
            controller.close()
          }
          return
        }
      } catch (error) {
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      reader.releaseLock()
    }
  })
}

function finalizeAttachmentMediaStream(
  source: ReadableStream<Uint8Array>,
  finalize: () => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let finalized = false
  const finish = (): void => {
    if (finalized) return
    finalized = true
    finalize()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          finish()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        reader.releaseLock()
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      reader.releaseLock()
      finish()
    }
  })
}

async function fetchCiphertext(
  capability: AttachmentMediaCapability,
  range: string,
  refreshAccessToken: RefreshAccessToken,
  signal: AbortSignal
): Promise<Response> {
  const url = new URL(`/api/v1/attachments/${capability.attachmentId}`, capability.serverUrl)
  const perform = async (): Promise<Response> => await fetch(url, {
    redirect: 'error',
    signal,
    headers: {
      authorization: `Bearer ${capability.accessToken}`,
      range
    }
  })

  let response = await perform()
  if (response.status === 401) {
    const refreshed = await refreshAccessToken(capability.serverUrl)
    if (refreshed) {
      capability.accessToken = refreshed
      response = await perform()
    }
  }
  return response
}

async function handleMediaRequest(
  request: Request,
  refreshAccessToken: RefreshAccessToken
): Promise<Response> {
  const url = new URL(request.url)
  const token = url.hostname === 'media' ? url.pathname.slice(1) : ''
  const capability = capabilities.get(token)
  if (!capability) return new Response('attachment capability expired', { status: 404 })

  const requestedRange = parseAttachmentMediaRange(
    request.headers.get('range'),
    capability.plaintextSize
  )
  if (requestedRange === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${capability.plaintextSize}` }
    })
  }

  const plaintextStart = requestedRange?.start ?? 0
  const plaintextEndExclusive = requestedRange
    ? requestedRange.endInclusive + 1
    : capability.plaintextSize
  const plan = planAttachmentPlaintextRange(
    capability.plaintextSize,
    plaintextStart,
    plaintextEndExclusive
  )
  const ciphertextRange = `bytes=${plan.ciphertextStart}-${plan.ciphertextEndExclusive - 1}`
  const requestController = new AbortController()
  capability.activeRequests.add(requestController)
  const finishRequest = (): void => {
    capability.activeRequests.delete(requestController)
  }

  let response: Response
  try {
    response = await fetchCiphertext(
      capability,
      ciphertextRange,
      refreshAccessToken,
      requestController.signal
    )
  } catch (error) {
    finishRequest()
    throw error
  }
  if (response.status !== 206 || !response.body) {
    finishRequest()
    return new Response('attachment source unavailable', { status: response.status || 502 })
  }

  const expectedContentRange =
    `bytes ${plan.ciphertextStart}-${plan.ciphertextEndExclusive - 1}/`
  if (!response.headers.get('content-range')?.startsWith(expectedContentRange)) {
    await response.body.cancel('unexpected attachment ciphertext range')
    finishRequest()
    return new Response('attachment source range mismatch', { status: 502 })
  }

  const decrypted = decryptAttachmentStreamV2(
    response.body,
    capability.encryption,
    capability.plaintextSize,
    plan.firstChunk,
    plan.lastChunk
  )
  const body = finalizeAttachmentMediaStream(
    sliceAttachmentPlaintextStream(
      decrypted,
      plan.discardPlaintextPrefix,
      plan.plaintextLength
    ),
    finishRequest
  )
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store, no-transform',
    'content-length': integerString(plan.plaintextLength),
    'content-type': capability.contentType,
    'x-content-type-options': 'nosniff'
  }

  if (requestedRange) {
    headers['content-range'] =
      `bytes ${requestedRange.start}-${requestedRange.endInclusive}/${capability.plaintextSize}`
  }

  return new Response(body, { status: requestedRange ? 206 : 200, headers })
}

function integerString(value: number): string {
  return value.toString(10)
}

function deleteCapability(token: string): void {
  const capability = capabilities.get(token)
  if (!capability) return
  for (const controller of capability.activeRequests) {
    controller.abort(new DOMException('Attachment media capability released', 'AbortError'))
  }
  capability.activeRequests.clear()
  capabilities.delete(token)
}

function clearCapabilitiesForOwner(owner: WebContents): void {
  for (const [token, capability] of capabilities) {
    if (capability.ownerWebContentsId === owner.id) deleteCapability(token)
  }
}

export function registerAttachmentMediaProtocol(refreshAccessToken: RefreshAccessToken): void {
  protocol.handle(ATTACHMENT_MEDIA_SCHEME, async (request) => {
    try {
      return await handleMediaRequest(request, refreshAccessToken)
    } catch {
      return new Response('attachment could not be decrypted', { status: 502 })
    }
  })

  ipcMain.handle('attachmentMedia:register', (event, rawRegistration: unknown) => {
    const registration = validRegistration(rawRegistration)
    if (!registration) throw new Error('invalid attachment media registration')
    const token = randomBytes(32).toString('hex')
    capabilities.set(token, {
      ...registration,
      ownerWebContentsId: event.sender.id,
      activeRequests: new Set()
    })
    return `${ATTACHMENT_MEDIA_SCHEME}://media/${token}`
  })

  ipcMain.handle('attachmentMedia:release', (event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string') return false
    try {
      const url = new URL(rawUrl)
      const token = url.protocol === `${ATTACHMENT_MEDIA_SCHEME}:` && url.hostname === 'media'
        ? url.pathname.slice(1)
        : ''
      const capability = capabilities.get(token)
      if (!capability || capability.ownerWebContentsId !== event.sender.id) return false
      deleteCapability(token)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('attachmentMedia:clear', (event) => {
    clearCapabilitiesForOwner(event.sender)
  })
}

export function watchAttachmentMediaOwner(owner: WebContents): void {
  owner.once('destroyed', () => clearCapabilitiesForOwner(owner))
}

export function clearAttachmentMediaCapabilities(): void {
  for (const token of capabilities.keys()) deleteCapability(token)
}
