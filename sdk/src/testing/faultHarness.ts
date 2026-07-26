export class InjectedDroppedAckError extends Error {
  constructor() {
    super('Injected fault: acknowledgement dropped after operation completed.')
    this.name = 'InjectedDroppedAckError'
  }
}

export async function injectDroppedAck<T>(operation: () => Promise<T>): Promise<never> {
  await operation()
  throw new InjectedDroppedAckError()
}

export async function injectDuplicateDelivery<T>(
  event: T,
  deliver: (event: T) => Promise<void>
): Promise<void> {
  await deliver(event)
  await deliver(event)
}

export function injectReorderedReplayPage<T>(events: readonly T[]): T[] {
  if (events.length < 2) {
    return [...events]
  }

  return [events[1], events[0], ...events.slice(2)]
}

export async function injectRestart<T>(
  stop: () => void,
  restart: () => Promise<T> | T
): Promise<T> {
  stop()
  return await restart()
}
