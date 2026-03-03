/**
 * Browser notification shim for the web client.
 * In Electron, window.cryptoDb is set by preload — this returns early.
 * In the browser, sets up window.notifications and window.electron stubs.
 */
export function initWebNotifications(): void {
  // Electron — preload already set up everything
  if (window.cryptoDb) return

  // Browser Notification API for message notifications
  ;(window as Record<string, unknown>).notifications = {
    showMessageNotification(data: {
      title: string
      body: string
      channelId?: string
      conversationId?: string
    }): void {
      if (Notification.permission === 'default') {
        Notification.requestPermission()
        return
      }
      if (Notification.permission === 'granted') {
        new Notification(data.title, { body: data.body })
      }
    }
  }

  // Stub window.electron.ipcRenderer so IncomingCallModal doesn't throw
  window.electron = {
    ipcRenderer: {
      invoke: async () => {},
      send: () => {},
      on: () => () => {}
    }
  }
}
