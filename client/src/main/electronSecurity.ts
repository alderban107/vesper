import type { WebPreferences } from 'electron'

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

export function normalizeHttpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

export function isAllowedRendererNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)
    if (target.protocol !== current.protocol) {
      return false
    }

    return current.protocol === 'file:'
      ? target.pathname === current.pathname
      : target.origin === current.origin
  } catch {
    return false
  }
}
