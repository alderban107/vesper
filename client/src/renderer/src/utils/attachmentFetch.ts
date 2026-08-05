import { getRendererClient } from '../sdk/client'

const ATTACHMENT_FETCH_RETRY_DELAYS_MS = [0, 180, 500, 1200] as const

function shouldRetryAttachmentFetch(status: number, attempt: number): boolean {
  if (attempt >= ATTACHMENT_FETCH_RETRY_DELAYS_MS.length - 1) return false
  if (!Number.isFinite(status)) return attempt < 2
  if (status === 404) return true
  if (status === 408 || status === 425 || status === 429 || status >= 500) return attempt < 1
  return false
}

async function waitForRetry(attempt: number): Promise<void> {
  const delay = ATTACHMENT_FETCH_RETRY_DELAYS_MS[attempt]
  if (delay > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  }
}

export async function fetchAttachmentResponse(
  attachmentId: string,
  options: { signal?: AbortSignal; range?: string; ifRange?: string } = {}
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < ATTACHMENT_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    await waitForRetry(attempt)

    try {
      return await getRendererClient().fetchAttachmentResponse(attachmentId, options)
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error instanceof Error ? error : new Error('attachment fetch failed')
      const statusMatch = /status (\d+)/.exec(lastError.message)
      const status = statusMatch ? Number.parseInt(statusMatch[1] ?? '', 10) : NaN
      if (shouldRetryAttachmentFetch(status, attempt)) continue
      throw lastError
    }
  }

  throw lastError ?? new Error('attachment fetch failed')
}

export async function fetchAttachmentBytes(attachmentId: string): Promise<ArrayBuffer> {
  return await (await fetchAttachmentResponse(attachmentId)).arrayBuffer()
}
