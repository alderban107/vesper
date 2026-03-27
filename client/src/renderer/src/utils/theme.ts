import { setStoredValue } from './localStorage'

export type ThemeOption = 'dark' | 'light' | 'auto'

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(option: ThemeOption): 'dark' | 'light' {
  return option === 'auto' ? getSystemTheme() : option
}

export function applyTheme(option: ThemeOption): void {
  const resolved = resolveTheme(option)
  document.documentElement.setAttribute('data-theme', resolved)
}

export function saveAndApplyTheme(option: ThemeOption): void {
  setStoredValue('theme', option)
  applyTheme(option)
}

let mediaQueryCleanup: (() => void) | null = null

export function watchSystemTheme(onThemeChange: (resolved: 'dark' | 'light') => void): () => void {
  if (mediaQueryCleanup) mediaQueryCleanup()

  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const handler = (): void => {
    onThemeChange(mq.matches ? 'light' : 'dark')
  }
  mq.addEventListener('change', handler)

  mediaQueryCleanup = () => {
    mq.removeEventListener('change', handler)
    mediaQueryCleanup = null
  }

  return mediaQueryCleanup
}
