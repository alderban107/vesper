import { apiFetch } from './client'

/**
 * Upload key packages to the server directory.
 */
export async function uploadKeyPackages(
  packages: Uint8Array[]
): Promise<boolean> {
  const res = await apiFetch('/api/v1/key-packages', {
    method: 'POST',
    body: JSON.stringify({
      key_packages: packages.map((p) => uint8ToBase64(p))
    })
  })
  return res.ok
}

/**
 * Fetch one unconsumed key package for a user.
 */
export async function fetchKeyPackage(
  userId: string
): Promise<Uint8Array | null> {
  const res = await apiFetch(`/api/v1/key-packages/${userId}`)
  if (!res.ok) return null

  const data = await res.json()
  if (!data.key_package) return null
  return base64ToUint8(data.key_package)
}

/**
 * Get count of unconsumed key packages for the current user.
 */
export async function getMyKeyPackageCount(): Promise<number> {
  const res = await apiFetch('/api/v1/key-packages/me/count')
  if (!res.ok) return 0

  const data = await res.json()
  return data.count || 0
}

/**
 * Fetch pending Welcome messages for an MLS scope.
 */
export async function fetchPendingWelcomes(
  scopeId: string
): Promise<
  Array<{
    id: string
    welcome_data: Uint8Array
    sender_id: string
  }>
> {
  const res = await apiFetch(`/api/v1/pending-welcomes/${encodeURIComponent(scopeId)}`)
  if (!res.ok) return []

  const data = await res.json()
  return (data.welcomes || []).map(
    (w: { id: string; welcome_data: string; sender_id: string }) => ({
      id: w.id,
      welcome_data: base64ToUint8(w.welcome_data),
      sender_id: w.sender_id
    })
  )
}

/**
 * Acknowledge (delete) a processed pending Welcome.
 */
export async function ackPendingWelcome(welcomeId: string): Promise<void> {
  await apiFetch(`/api/v1/pending-welcomes/${welcomeId}`, {
    method: 'DELETE'
  })
}

/**
 * Fetch pending MLS resync requests for an MLS scope.
 */
export async function fetchPendingResyncRequests(
  scopeId: string
): Promise<
  Array<{
    id: string
    requester_id: string
    requester_username: string | null
    request_id: string
    last_known_epoch: number | null
    reason: string | null
  }>
> {
  const res = await apiFetch(`/api/v1/pending-resync-requests/${encodeURIComponent(scopeId)}`)
  if (!res.ok) return []

  const data = await res.json()
  return data.requests || []
}

/**
 * Acknowledge (delete) a processed pending MLS resync request.
 */
export async function ackPendingResyncRequest(requestId: string): Promise<void> {
  await apiFetch(`/api/v1/pending-resync-requests/${requestId}`, {
    method: 'DELETE'
  })
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
