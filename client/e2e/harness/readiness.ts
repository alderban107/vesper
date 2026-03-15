/**
 * Readiness checks for backend and frontend.
 * Covers: R-HARNESS-4 (readiness checks replace blind sleeps)
 */

export async function waitForUrl(
  url: string,
  opts: { timeout?: number; interval?: number; label?: string } = {}
): Promise<void> {
  const { timeout = 60_000, interval = 500, label = url } = opts
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await sleep(interval)
  }

  throw new Error(`${label} did not become ready within ${timeout}ms`)
}

export async function waitForHealth(apiUrl: string, timeout = 60_000): Promise<void> {
  await waitForUrl(`${apiUrl}/health`, { timeout, label: 'Phoenix API /health' })
}

export async function waitForVite(clientUrl: string, timeout = 60_000): Promise<void> {
  await waitForUrl(clientUrl, { timeout, label: 'Vite dev server' })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
