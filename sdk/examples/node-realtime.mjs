import {
  VesperSocketClient
} from '../dist/transport/index.js'
import { createSdkHarness, registerOrLogin, requiredEnv } from './_shared.mjs'

const username = requiredEnv('VESPER_USERNAME')
const password = requiredEnv('VESPER_PASSWORD')

const { auth, sessionStore } = createSdkHarness('realtime')
const session = await registerOrLogin(auth, username, password)

const socketClient = new VesperSocketClient({
  getAccessToken: () => sessionStore.getAccessToken(),
  getServerUrl: () => sessionStore.getServerUrl()
})

const events = []
const topic = `user:${session.user.id}`

socketClient.connect()

try {
  await socketClient.joinChannelWithAck(topic, (event, payload) => {
    events.push({ event, payload })
    console.log('[socket-event]', event)
  })

  socketClient.pushToChannel(topic, 'heartbeat', {})

  console.log(JSON.stringify({
    mode: 'realtime',
    topic,
    connected: Boolean(socketClient.getChannel(topic)),
    serverUrl: sessionStore.getServerUrl(),
    userId: session.user.id
  }, null, 2))
} finally {
  socketClient.disconnect()
}
