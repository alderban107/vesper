/** Fire-and-forget: swallows errors for best-effort background operations. */
export function fireAndForget(promise: Promise<unknown>): void {
  void promise.catch(() => {})
}
