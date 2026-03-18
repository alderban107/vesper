import { apiFetch } from '@vesper/sdk/transport'

const ATTACHMENT_FETCH_RETRY_DELAYS_MS = [0, 180, 500, 1200] as const

function shouldRetryAttachmentFetch(status: number, attempt: number): boolean {
  return (
    attempt < ATTACHMENT_FETCH_RETRY_DELAYS_MS.length - 1 &&
    (status === 404 || status === 408 || status === 425 || status === 429 || status >= 500)
  )
}

async function waitForRetry(attempt: number): Promise<void> {
  const delay = ATTACHMENT_FETCH_RETRY_DELAYS_MS[attempt]
  if (delay > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  }
}

export async function fetchAttachmentBytes(attachmentId: string): Promise<ArrayBuffer> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < ATTACHMENT_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    await waitForRetry(attempt)

    try {
      const response = await apiFetch(`/api/v1/attachments/${attachmentId}`)
      if (response.ok) {
        return await response.arrayBuffer()
      }

      lastError = new Error(`attachment fetch failed with status ${response.status}`)
      if (!shouldRetryAttachmentFetch(response.status, attempt)) {
        throw lastError
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('attachment fetch failed')
      if (attempt === ATTACHMENT_FETCH_RETRY_DELAYS_MS.length - 1) {
        throw lastError
      }
    }
  }

  throw lastError ?? new Error('attachment fetch failed')
}
