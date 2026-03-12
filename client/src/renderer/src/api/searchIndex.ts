import { apiFetch } from './client'

export interface SearchIndexSnapshotPayload {
  version: number
  generated_at: string
  messages: Array<{
    id: string
    channel_id: string | null
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    content: string | null
    attachment_filenames: string[]
    inserted_at: string
  }>
}

export interface SearchIndexSnapshotResponse {
  version: number
  device_id: string
  ciphertext: string
  nonce: string
  updated_at: string
}

export async function fetchSearchIndexSnapshot(): Promise<SearchIndexSnapshotResponse | null> {
  const res = await apiFetch('/api/v1/search-index')
  if (!res.ok) {
    return null
  }

  const data = await res.json()
  return (data.snapshot as SearchIndexSnapshotResponse | null) ?? null
}

export async function saveSearchIndexSnapshot(params: {
  deviceId: string
  ciphertext: string
  nonce: string
  expectedVersion?: number
}): Promise<
  | { ok: true; snapshot: SearchIndexSnapshotResponse }
  | { ok: false; conflict: SearchIndexSnapshotResponse | null }
  | { ok: false; conflict: null }
> {
  const body: Record<string, unknown> = {
    device_id: params.deviceId,
    ciphertext: params.ciphertext,
    nonce: params.nonce
  }

  if (typeof params.expectedVersion === 'number') {
    body.expected_version = params.expectedVersion
  }

  const res = await apiFetch('/api/v1/search-index', {
    method: 'PUT',
    body: JSON.stringify(body)
  })

  if (res.status === 409) {
    const data = await res.json()
    return {
      ok: false,
      conflict: (data.snapshot as SearchIndexSnapshotResponse | null) ?? null
    }
  }

  if (!res.ok) {
    return { ok: false, conflict: null }
  }

  const data = await res.json()
  return {
    ok: true,
    snapshot: data.snapshot as SearchIndexSnapshotResponse
  }
}

export async function deleteSearchIndexSnapshot(): Promise<void> {
  await apiFetch('/api/v1/search-index', {
    method: 'DELETE'
  })
}
