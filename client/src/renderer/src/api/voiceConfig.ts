import { apiFetch } from './client'

export interface VoiceRtcConfig {
  iceServers: RTCIceServer[]
  iceTransportPolicy: RTCIceTransportPolicy
}

const DEFAULT_VOICE_RTC_CONFIG: VoiceRtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceTransportPolicy: 'all'
}

let cachedVoiceRtcConfig: VoiceRtcConfig | null = null
let voiceRtcConfigRequest: Promise<VoiceRtcConfig> | null = null

function normalizeIceTransportPolicy(value: unknown): RTCIceTransportPolicy {
  return value === 'relay' ? 'relay' : 'all'
}

function normalizeIceServer(entry: unknown): RTCIceServer | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const candidate = entry as {
    urls?: unknown
    username?: unknown
    credential?: unknown
  }

  if (
    typeof candidate.urls !== 'string' &&
    !(
      Array.isArray(candidate.urls) &&
      candidate.urls.every((item) => typeof item === 'string')
    )
  ) {
    return null
  }

  return {
    urls: candidate.urls as string | string[],
    ...(typeof candidate.username === 'string' ? { username: candidate.username } : {}),
    ...(typeof candidate.credential === 'string' ? { credential: candidate.credential } : {})
  }
}

function normalizeVoiceRtcConfig(payload: unknown): VoiceRtcConfig {
  if (!payload || typeof payload !== 'object') {
    return DEFAULT_VOICE_RTC_CONFIG
  }

  const raw = payload as {
    ice_servers?: unknown
    ice_transport_policy?: unknown
  }

  const iceServers = Array.isArray(raw.ice_servers)
    ? raw.ice_servers.map(normalizeIceServer).filter((entry): entry is RTCIceServer => Boolean(entry))
    : []

  return {
    iceServers: iceServers.length > 0 ? iceServers : DEFAULT_VOICE_RTC_CONFIG.iceServers,
    iceTransportPolicy: normalizeIceTransportPolicy(raw.ice_transport_policy)
  }
}

export async function getVoiceRtcConfig(forceRefresh = false): Promise<VoiceRtcConfig> {
  if (cachedVoiceRtcConfig && !forceRefresh) {
    return cachedVoiceRtcConfig
  }

  if (voiceRtcConfigRequest && !forceRefresh) {
    return voiceRtcConfigRequest
  }

  voiceRtcConfigRequest = (async () => {
    try {
      const response = await apiFetch('/api/v1/voice/config')
      if (!response.ok) {
        cachedVoiceRtcConfig = DEFAULT_VOICE_RTC_CONFIG
        return cachedVoiceRtcConfig
      }

      const payload = await response.json()
      cachedVoiceRtcConfig = normalizeVoiceRtcConfig(payload)
      return cachedVoiceRtcConfig
    } catch {
      cachedVoiceRtcConfig = DEFAULT_VOICE_RTC_CONFIG
      return cachedVoiceRtcConfig
    } finally {
      voiceRtcConfigRequest = null
    }
  })()

  return voiceRtcConfigRequest
}
