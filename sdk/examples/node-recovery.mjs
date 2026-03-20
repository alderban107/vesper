import { createSdkHarness, requiredEnv } from './_shared.mjs'

const mnemonic = requiredEnv('VESPER_RECOVERY_KEY')
const newPassword = requiredEnv('VESPER_NEW_PASSWORD')

const { auth, sessionStore } = createSdkHarness('recovery')

await auth.verifyRecoveryKey(mnemonic)
const session = await auth.recoverAccount(mnemonic, newPassword)

console.log(JSON.stringify({
  mode: 'recovery',
  userId: session.user.id,
  username: session.user.username,
  currentDeviceId: session.currentDevice?.id ?? null,
  trustState: session.currentDevice?.trust_state ?? null,
  canUseE2EE: session.canUseE2EE,
  serverUrl: sessionStore.getServerUrl()
}, null, 2))
