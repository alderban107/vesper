/**
 * Per-group async mutex to prevent concurrent MLS state mutations.
 *
 * MLS state is ratcheted on every encrypt/decrypt/commit operation.
 * Without serialization, concurrent operations can read stale state,
 * produce conflicting updates, and corrupt the group.
 */

const locks = new Map<string, Promise<void>>()

/**
 * Acquire an exclusive lock for the given group ID.
 * Returns a release function. All MLS state-mutating operations
 * for a group must be wrapped in this lock.
 *
 * Usage:
 *   const release = await acquireGroupLock(channelId)
 *   try {
 *     // ... mutate MLS state ...
 *   } finally {
 *     release()
 *   }
 */
export async function acquireGroupLock(groupId: string): Promise<() => void> {
  // Wait for any existing lock on this group
  while (locks.has(groupId)) {
    await locks.get(groupId)
  }

  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(groupId, promise)

  return () => {
    locks.delete(groupId)
    release()
  }
}

/**
 * Convenience wrapper: execute a function while holding the group lock.
 */
export async function withGroupLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireGroupLock(groupId)
  try {
    return await fn()
  } finally {
    release()
  }
}
