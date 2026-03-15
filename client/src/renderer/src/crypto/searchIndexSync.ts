export async function initializeSearchIndexSync(
  _userId: string,
  _password: string
): Promise<void> {}

export async function resumeSearchIndexSync(_userId: string): Promise<boolean> {
  return false
}

export function clearSearchIndexSyncCredentials(): void {}

export async function clearPersistedSearchIndexSyncKey(
  _userId: string
): Promise<void> {}

export function scheduleSearchIndexSync(): void {}

export async function flushSearchIndexSync(): Promise<void> {}
