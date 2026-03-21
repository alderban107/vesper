import { getDefaultHttpClient, type VesperHttpClient } from './client.js'

/**
 * Upload key packages (pre-key bundles) to the server directory.
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
 * Fetch one unconsumed key package (pre-key bundle) for a user.
 * Used during X3DH session establishment — the recipient doesn't need to be online.
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
 * Mark a specific own key package as consumed on the server.
 * Called after consuming a key package locally (e.g. during session establishment)
 * to prevent the server from handing out the stale package to other clients.
 */
export async function consumeOwnKeyPackage(
  keyPackageData: Uint8Array,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch('/api/v1/key-packages/me/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key_package: uint8ToBase64(keyPackageData) })
  })
  // Best-effort — don't throw on failure since the local consumption already succeeded
  if (!res.ok) {
    // Silently ignore; the package may have already been consumed by a fetch
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
