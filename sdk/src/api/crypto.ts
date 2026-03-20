import { getDefaultHttpClient, type VesperHttpClient } from './client.js'

/**
 * Upload key packages to the server directory.
 */
export async function uploadKeyPackages(
  packages: Uint8Array[],
  deviceId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch('/api/v1/key-packages', {
    method: 'POST',
    body: JSON.stringify({
      device_id: deviceId,
      key_packages: packages.map((p) => uint8ToBase64(p))
    })
  })
  if (!res.ok) {
    throw new Error(`Could not upload key packages: ${res.status}`)
  }
}

/**
 * Fetch one unconsumed key package for a user.
 */
export async function fetchKeyPackage(
  userId: string,
  deviceId?: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<Uint8Array | null> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  const res = await httpClient.apiFetch(`/api/v1/key-packages/${userId}${query}`)
  if (!res.ok) {
    throw new Error(`Could not fetch key package for user ${userId}: ${res.status}`)
  }

  const data = await res.json()
  if (!data.key_package) return null
  return base64ToUint8(data.key_package)
}

/**
 * Purge all unconsumed key packages for the current user.
 * Used when a new device is set up to remove stale packages from previous devices.
 */
export async function purgeMyKeyPackages(
  deviceId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const query = `?device_id=${encodeURIComponent(deviceId)}`
  const res = await httpClient.apiFetch(`/api/v1/key-packages/me${query}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`Could not purge key packages: ${res.status}`)
  }
}

/**
 * Get count of unconsumed key packages for the current user.
 */
export async function getMyKeyPackageCount(
  deviceId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<number> {
  const query = `?device_id=${encodeURIComponent(deviceId)}`
  const res = await httpClient.apiFetch(`/api/v1/key-packages/me/count${query}`)
  if (!res.ok) {
    throw new Error(`Could not fetch key package count: ${res.status}`)
  }

  const data = await res.json()
  return data.count || 0
}

/**
 * Fetch pending Welcome messages for an MLS scope.
 */
export async function fetchPendingWelcomes(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  Array<{
    id: string
    welcome_data: Uint8Array
    key_package_ref?: string | null
    sender_id: string
  }>
> {
  const res = await httpClient.apiFetch(`/api/v1/pending-welcomes/${encodeURIComponent(scopeId)}`)
  if (!res.ok) {
    throw new Error(`Could not fetch pending welcomes for scope ${scopeId}: ${res.status}`)
  }

  const data = await res.json()
  return (data.welcomes || []).map(
    (w: { id: string; welcome_data: string; key_package_ref?: string | null; sender_id: string }) => ({
      id: w.id,
      welcome_data: base64ToUint8(w.welcome_data),
      key_package_ref: typeof w.key_package_ref === 'string' ? w.key_package_ref : null,
      sender_id: w.sender_id
    })
  )
}

/**
 * Acknowledge (delete) a processed pending Welcome.
 */
export async function ackPendingWelcome(
  welcomeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch(`/api/v1/pending-welcomes/${welcomeId}`, {
    method: 'DELETE'
  })
  if (!res.ok) {
    throw new Error(`Could not acknowledge pending welcome ${welcomeId}: ${res.status}`)
  }
}

/**
 * Fetch pending MLS resync requests for an MLS scope.
 */
export async function fetchPendingResyncRequests(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  Array<{
    id: string
    requester_id: string
    requester_username: string | null
    requester_client_id: string | null
    request_id: string
    last_known_epoch: number | null
    reason: string | null
  }>
> {
  const res = await httpClient.apiFetch(
    `/api/v1/pending-resync-requests/${encodeURIComponent(scopeId)}`
  )
  if (!res.ok) {
    throw new Error(`Could not fetch pending resync requests for scope ${scopeId}: ${res.status}`)
  }

  const data = await res.json()
  return data.requests || []
}

/**
 * Acknowledge (delete) a processed pending MLS resync request.
 */
export async function ackPendingResyncRequest(
  requestId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch(`/api/v1/pending-resync-requests/${requestId}`, {
    method: 'DELETE'
  })
  if (!res.ok) {
    throw new Error(`Could not acknowledge pending resync request ${requestId}: ${res.status}`)
  }
}

/**
 * Fetch pending same-user history requests for an MLS scope.
 */
export async function fetchPendingHistoryRequests(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  Array<{
    id: string
    requester_id: string
    requester_username: string | null
    requester_client_id: string | null
  }>
> {
  const res = await httpClient.apiFetch(
    `/api/v1/pending-history-requests/${encodeURIComponent(scopeId)}`
  )
  if (!res.ok) {
    throw new Error(`Could not fetch pending history requests for scope ${scopeId}: ${res.status}`)
  }

  const data = await res.json()
  return data.requests || []
}

/**
 * Acknowledge a processed pending same-user history request.
 */
export async function ackPendingHistoryRequest(
  requestId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch(`/api/v1/pending-history-requests/${requestId}`, {
    method: 'DELETE'
  })
  if (!res.ok) {
    throw new Error(`Could not acknowledge pending history request ${requestId}: ${res.status}`)
  }
}

/**
 * Fetch pending same-user history bundles for an MLS scope.
 */
export async function fetchPendingHistoryBundles(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  Array<{
    id: string
    ciphertext: string
    mls_epoch: number
    recipient_id: string
    recipient_client_id: string | null
    sender_id: string
  }>
> {
  const res = await httpClient.apiFetch(
    `/api/v1/pending-history-bundles/${encodeURIComponent(scopeId)}`
  )
  if (!res.ok) {
    throw new Error(`Could not fetch pending history bundles for scope ${scopeId}: ${res.status}`)
  }

  const data = await res.json()
  return data.bundles || []
}

/**
 * Acknowledge a processed pending same-user history bundle.
 */
export async function ackPendingHistoryBundle(
  bundleId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch(`/api/v1/pending-history-bundles/${bundleId}`, {
    method: 'DELETE'
  })
  if (!res.ok) {
    throw new Error(`Could not acknowledge pending history bundle ${bundleId}: ${res.status}`)
  }
}

/**
 * Fetch durable MLS control-plane events for an encrypted scope after a local cursor.
 */
export async function fetchMlsEvents(
  scopeId: string,
  afterSeq: number,
  limit = 200,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  Array<{
    seq: number
    event_type: 'mls_commit' | 'mls_remove'
    payload: {
      commit_data?: string
      removed_user_id?: string
    }
    sender_id: string
    sender_device_id: string | null
  }>
> {
  const params = new URLSearchParams({
    after_seq: String(Math.max(0, afterSeq)),
    limit: String(limit)
  })
  const res = await httpClient.apiFetch(`/api/v1/mls-events/${encodeURIComponent(scopeId)}?${params}`)
  if (!res.ok) {
    throw new Error(`Could not fetch MLS events for scope ${scopeId}: ${res.status}`)
  }

  const data = await res.json()
  return data.events || []
}

// --- Helpers ---

function uint8ToBase64(arr: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i)
  }
  return arr
}

export { uint8ToBase64, base64ToUint8 }
