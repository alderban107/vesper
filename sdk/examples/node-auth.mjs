import { createSdkHarness, registerOrLogin, requiredEnv } from './_shared.mjs'

const username = requiredEnv('VESPER_USERNAME')
const password = requiredEnv('VESPER_PASSWORD')

const { auth, sessionStore } = createSdkHarness('auth')
const session = await registerOrLogin(auth, username, password)

console.log(JSON.stringify({
  mode: 'auth',
  userId: session.user.id,
  username: session.user.username,
  currentDeviceId: session.currentDevice?.id ?? null,
  trustState: session.currentDevice?.trust_state ?? null,
  canUseE2EE: session.canUseE2EE,
  hasRecoveryMnemonic: Boolean(session.recoveryMnemonic),
  serverUrl: sessionStore.getServerUrl()
}, null, 2))
