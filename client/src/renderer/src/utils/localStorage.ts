const isServer = typeof window === 'undefined'

export function getStoredValue(key: string): string | null {
  if (isServer) return null
  return localStorage.getItem(key)
}

export function setStoredValue(key: string, value: string): void {
  if (isServer) return
  localStorage.setItem(key, value)
}

export function removeStoredValue(key: string): void {
  if (isServer) return
  localStorage.removeItem(key)
}

export function writeStoredValue(key: string, value: string | null): void {
  if (value) {
    setStoredValue(key, value)
  } else {
    removeStoredValue(key)
  }
}

export function getStoredJson<T>(key: string, fallback: T): T {
  if (isServer) return fallback
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

export function setStoredJson(key: string, value: unknown): void {
  if (isServer) return
  localStorage.setItem(key, JSON.stringify(value))
}
