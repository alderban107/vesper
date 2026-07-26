import { getDefaultHttpClient, type VesperHttpClient } from './client.js'
import { base64ToUint8, uint8ToBase64 } from './encoding.js'

export { base64ToUint8, uint8ToBase64 }

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
 * Mark a specific own key package as consumed on the server.
 * Called after consuming a key package locally (e.g. during group creation)
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
  requestToken: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const res = await httpClient.apiFetch(
    `/api/v1/pending-resync-requests/${requestId}?request_id=${encodeURIComponent(requestToken)}`,
    {
      method: 'DELETE'
    }
  )
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
    membership_generation: number
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
      transition_type?: 'external_commit' | 'sponsored_join'
      joined_user_id?: string
      joined_device_id?: string | null
      removed_user_id?: string
      removed_device_id?: string | null
      removals?: Array<{
        removed_user_id?: string
        removed_device_id?: string | null
      }>
      resulting_generation?: number
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

// --- GroupInfo (for External Commits) ---

/**
 * Publish MLS GroupInfo to the server for External Commit joins.
 * Should be called after every epoch change (add, remove, update, external commit).
 *
 * When `previousEpoch` is provided, uses compare-and-swap (CAS) semantics:
 * the server only accepts the update if the stored epoch matches previousEpoch.
 * Returns 'conflict' on mismatch (another joiner claimed the epoch first).
 */
export async function publishGroupInfo(
  scopeId: string,
  groupInfoData: Uint8Array,
  ratchetTreeData: Uint8Array | null,
  epoch: number,
  httpClient: VesperHttpClient = getDefaultHttpClient(),
  previousEpoch?: number
): Promise<'ok' | 'conflict'> {
  const body: Record<string, unknown> = {
    group_info_data: uint8ToBase64(groupInfoData),
    epoch
  }
  if (ratchetTreeData) {
    body.ratchet_tree_data = uint8ToBase64(ratchetTreeData)
  }
  if (previousEpoch !== undefined) {
    body.previous_epoch = previousEpoch
  }

  const res = await httpClient.apiFetch(
    `/api/v1/group-info/${encodeURIComponent(scopeId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(body)
    }
  )

  if (res.status === 409) {
    return 'conflict'
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Failed to publish GroupInfo: ${res.status} ${data.error || ''}`)
  }

  return 'ok'
}

export async function publishExternalCommitGroupInfo(
  scopeId: string,
  groupInfoData: Uint8Array,
  ratchetTreeData: Uint8Array | null,
  epoch: number,
  previousEpoch: number,
  commitData: string,
  commitId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  | { status: 'ok'; commitEventSeq: number | null }
  | { status: 'conflict' }
> {
  const body: Record<string, unknown> = {
    group_info_data: uint8ToBase64(groupInfoData),
    epoch,
    previous_epoch: previousEpoch,
    commit_data: commitData,
    commit_id: commitId
  }

  if (ratchetTreeData) {
    body.ratchet_tree_data = uint8ToBase64(ratchetTreeData)
  }

  const res = await httpClient.apiFetch(
    `/api/v1/group-info/${encodeURIComponent(scopeId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(body)
    }
  )

  if (res.status === 409) {
    return { status: 'conflict' }
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Failed to publish External Commit GroupInfo: ${res.status} ${data.error || ''}`)
  }

  const data = await res.json().catch(() => ({}))
  return {
    status: 'ok',
    commitEventSeq: typeof data.commit_event_seq === 'number' ? data.commit_event_seq : null
  }
}

export async function publishSponsoredTransition(
  scopeId: string,
  transition: {
    groupInfoData: Uint8Array
    ratchetTreeData: Uint8Array | null
    epoch: number
    previousEpoch: number
    recipientId: string
    recipientClientId: string | null
    recipientKeyPackageRef: string | null
    commitData: string
    commitId: string
    removeCommitData: string | null
    welcomeData: string | null
  },
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<
  | {
      status: 'ok'
      fresh: boolean
      commitEventSeq: number | null
      removeEventSeq: number | null
      welcomeId: string | null
    }
  | {
      status: 'conflict'
      currentEpoch: number | null
    }
> {
  const body: Record<string, unknown> = {
    group_info_data: uint8ToBase64(transition.groupInfoData),
    epoch: transition.epoch,
    previous_epoch: transition.previousEpoch,
    recipient_id: transition.recipientId,
    commit_data: transition.commitData,
    commit_id: transition.commitId
  }

  if (transition.ratchetTreeData) {
    body.ratchet_tree_data = uint8ToBase64(transition.ratchetTreeData)
  }

  if (transition.recipientClientId) {
    body.recipient_device_id = transition.recipientClientId
  }

  if (transition.recipientKeyPackageRef) {
    body.recipient_key_package_ref = transition.recipientKeyPackageRef
  }

  if (transition.removeCommitData) {
    body.remove_commit_data = transition.removeCommitData
  }

  if (transition.welcomeData) {
    body.welcome_data = transition.welcomeData
  }

  const res = await httpClient.apiFetch(
    `/api/v1/mls-sponsored-transition/${encodeURIComponent(scopeId)}`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  )

  if (res.status === 409) {
    let currentEpoch: number | null = null
    try {
      const body = await res.json()
      if (typeof body.current_epoch === 'number') {
        currentEpoch = body.current_epoch
      }
    } catch {
      // ignore parse errors
    }
    return {
      status: 'conflict',
      currentEpoch
    }
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Failed to publish sponsored transition: ${res.status} ${data.error || ''}`)
  }

  const data = await res.json().catch(() => ({}))
  return {
    status: 'ok',
    fresh: data.fresh !== false,
    commitEventSeq: typeof data.commit_event_seq === 'number' ? data.commit_event_seq : null,
    removeEventSeq: typeof data.remove_event_seq === 'number' ? data.remove_event_seq : null,
    welcomeId: typeof data.welcome_id === 'string' ? data.welcome_id : null
  }
}

/**
 * Fetch the latest MLS GroupInfo from the server for External Commit joins.
 * Returns null if no GroupInfo has been published yet.
 */
export async function fetchGroupInfo(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<{
  groupInfoData: Uint8Array
  ratchetTreeData: Uint8Array | null
  epoch: number
  publisherId: string
} | null> {
  const res = await httpClient.apiFetch(
    `/api/v1/group-info/${encodeURIComponent(scopeId)}`
  )

  if (res.status === 404) {
    return null
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch GroupInfo: ${res.status}`)
  }

  const data = (await res.json()) as { group_info: {
    group_info_data: string
    ratchet_tree_data: string | null
    epoch: number
    publisher_id: string
  }}

  return {
    groupInfoData: base64ToUint8(data.group_info.group_info_data),
    ratchetTreeData: data.group_info.ratchet_tree_data
      ? base64ToUint8(data.group_info.ratchet_tree_data)
      : null,
    epoch: data.group_info.epoch,
    publisherId: data.group_info.publisher_id
  }
}
