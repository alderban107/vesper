import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, KeyRound, Laptop2, ShieldAlert } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'

export default function DeviceTrustGate(): React.JSX.Element | null {
  const currentDevice = useAuthStore((state) => state.currentDevice)
  const devices = useAuthStore((state) => state.devices)
  const canUseE2EE = useAuthStore((state) => state.canUseE2EE)
  const fetchDevices = useAuthStore((state) => state.fetchDevices)
  const approveDevice = useAuthStore((state) => state.approveDevice)
  const revokeDevice = useAuthStore((state) => state.revokeDevice)
  const approveCurrentDeviceWithRecovery = useAuthStore((state) => state.approveCurrentDeviceWithRecovery)
  const unlockTrustedDevice = useAuthStore((state) => state.unlockTrustedDevice)
  const error = useAuthStore((state) => state.error)

  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const pendingDevices = useMemo(
    () => devices.filter((device) => device.trust_state === 'pending'),
    [devices]
  )

  useEffect(() => {
    void fetchDevices().catch(() => {})
  }, [fetchDevices])

  if (!currentDevice) {
    return null
  }

  const isPending = currentDevice.trust_state !== 'trusted'
  const needsUnlock = currentDevice.trust_state === 'trusted' && !canUseE2EE
  const showPendingReviewCard = !isPending && !needsUnlock && pendingDevices.length > 0

  if (!isPending && !needsUnlock && !showPendingReviewCard) {
    return null
  }

  const handleRefresh = async (): Promise<void> => {
    setBusy('refresh')
    await fetchDevices().catch(() => {})
    setBusy(null)
  }

  const handleApproveCurrent = async (): Promise<void> => {
    setBusy('recovery')
    const approved = await approveCurrentDeviceWithRecovery(recoveryKey)
    if (approved) {
      setRecoveryKey('')
    }
    setBusy(null)
  }

  const handleUnlock = async (): Promise<void> => {
    setBusy('unlock')
    const unlocked = await unlockTrustedDevice(password)
    if (unlocked) {
      setPassword('')
    }
    setBusy(null)
  }

  if (showPendingReviewCard) {
    return (
      <div className="fixed right-5 bottom-5 z-[110] w-[360px] glass-card rounded-2xl border border-border/60 bg-bg-base/85 p-5 shadow-2xl">
        <div className="flex items-center gap-2 text-text-primary font-medium mb-3">
          <ShieldAlert className="w-4 h-4" />
          Review new device
        </div>
        <div className="space-y-3">
          {pendingDevices.map((device) => (
            <div key={device.id} className="rounded-xl border border-border/50 bg-bg-base/50 px-4 py-3">
              <div className="text-sm font-medium text-text-primary">{device.name}</div>
              <div className="text-xs text-text-faint mt-1">Waiting for approval</div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void approveDevice(device.id)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void revokeDevice(device.id)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[120] bg-bg-base/82 backdrop-blur-md flex items-center justify-center p-6">
      <div className="glass-card rounded-3xl max-w-3xl w-full p-8 animate-scale-in border border-border/60 shadow-2xl">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-accent/15 text-accent flex items-center justify-center">
            {needsUnlock ? <CheckCircle2 className="w-6 h-6" /> : <Laptop2 className="w-6 h-6" />}
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-text-primary">
              {needsUnlock ? 'Finish setting up this device' : 'Approve this device'}
            </h2>
            <p className="text-text-muted mt-2">
              {needsUnlock
                ? 'This device is approved. Enter your password once to unlock encrypted chats and calls here.'
                : 'Use another device you already trust, or use your recovery key here if this is your only device.'}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-2xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {needsUnlock ? (
          <div className="rounded-2xl border border-border/60 bg-bg-base/40 p-5">
            <label className="block text-sm text-text-muted mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="block w-full rounded-xl bg-bg-base/60 border border-border text-text-primary px-4 py-3 input-focus"
              placeholder="Enter your password"
            />
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleUnlock()}
                disabled={!password.trim() || busy !== null}
                className="glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold px-5 py-2.5 rounded-xl transition-all"
              >
                {busy === 'unlock' ? 'Unlocking...' : 'Unlock encrypted chats'}
              </button>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={busy !== null}
                className="px-4 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[1.2fr,0.8fr]">
            <div className="rounded-2xl border border-border/60 bg-bg-base/40 p-5">
              <div className="flex items-center gap-2 text-text-primary font-medium mb-3">
                <KeyRound className="w-4 h-4" />
                Use your recovery key on this device
              </div>
              <textarea
                value={recoveryKey}
                onChange={(event) => setRecoveryKey(event.target.value)}
                rows={4}
                className="block w-full rounded-xl bg-bg-base/60 border border-border text-text-primary px-4 py-3 input-focus resize-none"
                placeholder="Paste your 24-word recovery key"
              />
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleApproveCurrent()}
                  disabled={!recoveryKey.trim() || busy !== null}
                  className="glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold px-5 py-2.5 rounded-xl transition-all"
                >
                  {busy === 'recovery' ? 'Approving...' : 'Use recovery key'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={busy !== null}
                  className="px-4 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-border/60 bg-bg-base/40 p-5">
              <div className="flex items-center gap-2 text-text-primary font-medium mb-3">
                <ShieldAlert className="w-4 h-4" />
                Your devices
              </div>
              <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                {devices.length === 0 ? (
                  <div className="text-sm text-text-faint">No device info yet.</div>
                ) : (
                  devices.map((device) => (
                    <div
                      key={device.id}
                      className="rounded-xl border border-border/50 bg-bg-base/50 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-text-primary">{device.name}</div>
                          <div className="text-xs text-text-faint mt-1">
                            {device.trust_state === 'trusted'
                              ? 'Trusted'
                              : device.trust_state === 'pending'
                                ? 'Waiting for approval'
                                : 'Removed'}
                          </div>
                        </div>
                        {device.id === currentDevice.id ? (
                          <span className="text-xs text-accent-text">This device</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            {device.trust_state === 'pending' && (
                              <button
                                type="button"
                                onClick={() => void approveDevice(device.id)}
                                className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
                              >
                                Approve
                              </button>
                            )}
                            {device.trust_state !== 'revoked' && (
                              <button
                                type="button"
                                onClick={() => void revokeDevice(device.id)}
                                className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
