// Service worker for web push notifications.
// Handles push events and notification clicks.

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch {
    data = { type: 'message', sender_name: 'Vesper', body: event.data.text() }
  }

  let title = 'Vesper'
  let body = 'You have a new notification'
  let tag = 'vesper-notification'

  if (data.type === 'mention') {
    title = data.sender_name || 'Someone'
    body = `mentioned you in #${data.channel_name || 'a channel'}`
    if (data.server_name) {
      body += ` (${data.server_name})`
    }
    tag = `mention:${data.scope_id}`
  } else if (data.type === 'dm') {
    title = data.sender_name || 'Someone'
    body = 'sent you a message'
    tag = `dm:${data.scope_id}`
  } else if (data.type === 'call') {
    title = data.caller_name || 'Someone'
    body = 'is calling you'
    tag = `call:${data.scope_id}`
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/vesper-icon.png',
      data: {
        scope_type: data.scope_type,
        scope_id: data.scope_id
      },
      renotify: true
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const { scope_type, scope_id } = event.notification.data || {}
  let url = '/'
  if (scope_type && scope_id) {
    url = `/?navigate=${scope_type}:${scope_id}`
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          client.postMessage({ type: 'notification:navigate', scope_type, scope_id })
          return
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url)
    })
  )
})
