const DEVICE_ID_KEY = 'vesper:device:id'
const DEVICE_NAME_KEY = 'vesper:device:name'

function getNavigatorUserAgentData(): { platform?: string } | undefined {
  return (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
}

export interface LocalDeviceIdentity {
  id: string
  name: string
  platform: string
}

function defaultDeviceName(): string {
  const platform = getNavigatorUserAgentData()?.platform || navigator.platform || 'device'

  if (/iphone/i.test(platform)) {
    return 'iPhone'
  }

  if (/ipad/i.test(platform)) {
    return 'iPad'
  }

  if (/android/i.test(navigator.userAgent)) {
    return 'Android device'
  }

  if (/mac/i.test(platform)) {
    return 'Mac'
  }

  if (/win/i.test(platform)) {
    return 'Windows PC'
  }

  if (/linux/i.test(platform)) {
    return 'Linux PC'
  }

  return 'This device'
}

function normalizePlatform(): string {
  return getNavigatorUserAgentData()?.platform || navigator.platform || 'web'
}

export function getLocalDeviceIdentity(): LocalDeviceIdentity {
  const storedId = localStorage.getItem(DEVICE_ID_KEY)
  const storedName = localStorage.getItem(DEVICE_NAME_KEY)

  const id = storedId && storedId.length >= 8 ? storedId : crypto.randomUUID()
  const name = storedName && storedName.trim().length > 0 ? storedName.trim() : defaultDeviceName()
  const platform = normalizePlatform()

  localStorage.setItem(DEVICE_ID_KEY, id)
  localStorage.setItem(DEVICE_NAME_KEY, name)

  return { id, name, platform }
}

export function setLocalDeviceName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) {
    return
  }

  localStorage.setItem(DEVICE_NAME_KEY, trimmed)
}
