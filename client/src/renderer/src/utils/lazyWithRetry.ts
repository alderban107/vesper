import { lazy, type ComponentType } from 'react'

/**
 * Wraps React.lazy() with retry logic for stale chunk failures.
 *
 * After a deployment, the browser may have cached HTML that references
 * old chunk filenames (content-hashed). When the lazy import fires, the
 * old chunk URL 404s. Plain React.lazy() caches the rejected promise
 * permanently — clicking "Try Again" in an error boundary just returns
 * the same cached rejection.
 *
 * This wrapper retries the import up to `maxRetries` times, and on
 * final failure triggers a one-time page reload to get fresh HTML with
 * current chunk references. A sessionStorage flag prevents reload loops.
 */

const RELOAD_FLAG = 'vesper:chunk-reload'

type LazyImportFn<T extends ComponentType<never>> = () => Promise<{ default: T }>

export default function lazyWithRetry<T extends ComponentType<never>>(
  importFn: LazyImportFn<T>,
  maxRetries = 2
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await importFn()
      } catch (error) {
        if (attempt < maxRetries) {
          // Brief pause before retry — the server might just be slow
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          continue
        }

        // All retries exhausted. If we haven't already reloaded for a stale
        // chunk in this session, do so now to pick up fresh HTML/chunks.
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, '1')
          window.location.reload()
          // Return a never-resolving promise so React doesn't try to render
          // while the page is reloading.
          return await new Promise(() => {})
        }

        // We already reloaded once and it still failed — surface the error
        // so the error boundary can show it.
        sessionStorage.removeItem(RELOAD_FLAG)
        throw error
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error('Unexpected end of retry loop')
  })
}
