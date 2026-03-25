/**
 * Web Push subscription management for the browser client.
 * Handles service worker registration, push subscription, and
 * sending the subscription to the server.
 *
 * Push is opt-in only. Call subscribeToPush() when the user enables
 * push notifications in settings. Call unsubscribeFromPush() when
 * they disable it.
 */
import { getRendererClient } from '../sdk/client'
import { getStoredValue, writeStoredValue } from './localStorage'

const PUSH_ENABLED_KEY = 'pushNotificationsEnabled'

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.cryptoDb
}

function pushSupported(): boolean {
  return !isElectron() && 'serviceWorker' in navigator && 'PushManager' in window
}

export function isPushEnabled(): boolean {
  return getStoredValue(PUSH_ENABLED_KEY) === 'true'
}

/**
 * Register the service worker (idempotent). Called early so the SW
 * is ready when the user opts in, but does NOT subscribe to push.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return registration
  } catch {
    return null
  }
}

/**
 * Subscribe to web push. Fetches VAPID key from server, subscribes
 * via PushManager, and sends the subscription to the device endpoint.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!pushSupported()) return false

  try {
    const client = getRendererClient()
    const registration = await registerServiceWorker()
    if (!registration) return false

    // Fetch VAPID public key from server
    const response = await client.apiFetch('/api/v1/push/vapid-key')
    if (!response.ok) return false

    const { vapid_public_key } = await response.json()
    if (!vapid_public_key) return false

    // Convert base64url VAPID key to Uint8Array
    const applicationServerKey = urlBase64ToUint8Array(vapid_public_key)

    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer
    })

    // Send subscription to server as push_token
    const subscriptionJson = JSON.stringify(subscription.toJSON())
    await client.apiFetch('/api/v1/auth/devices/current/notifications', {
      method: 'PUT',
      body: JSON.stringify({
        push_token: subscriptionJson,
        push_platform: 'web',
        background_sync_capable: true
      })
    })

    writeStoredValue(PUSH_ENABLED_KEY, 'true')

    // Listen for notification clicks from SW
    setupNotificationClickListener()

    return true
  } catch {
    return false
  }
}

/**
 * Unsubscribe from web push and clear the push token on the server.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return

  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (registration) {
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await subscription.unsubscribe()
      }
    }

    // Clear push_token on server
    const client = getRendererClient()
    await client.apiFetch('/api/v1/auth/devices/current/notifications', {
      method: 'PUT',
      body: JSON.stringify({
        push_token: null,
        push_platform: 'web',
        background_sync_capable: false
      })
    })
  } catch {
    // Best-effort cleanup
  }

  writeStoredValue(PUSH_ENABLED_KEY, null)
}

/**
 * Listen for notification navigation messages from the service worker.
 */
function setupNotificationClickListener(): void {
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification:navigate') {
      const { scope_type, scope_id } = event.data
      if (scope_type && scope_id) {
        // Dispatch a custom event that stores can listen to
        window.dispatchEvent(
          new CustomEvent('vesper:navigate', { detail: { scope_type, scope_id } })
        )
      }
    }
  })
}

/**
 * Initialize push on app startup if previously enabled.
 * Registers the SW and re-subscribes if needed.
 */
export async function initPushIfEnabled(): Promise<void> {
  if (!pushSupported() || !isPushEnabled()) return

  await registerServiceWorker()
  setupNotificationClickListener()
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray
}
