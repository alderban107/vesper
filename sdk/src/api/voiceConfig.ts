import { getDefaultHttpClient, type VesperHttpClient } from './client.js'

export interface VoiceRtcConfig {
  iceServers: RTCIceServer[]
  iceTransportPolicy: RTCIceTransportPolicy
}

const DEFAULT_VOICE_RTC_CONFIG: VoiceRtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceTransportPolicy: 'all'
}

const cachedVoiceRtcConfigs = new Map<string, VoiceRtcConfig>()
const voiceRtcConfigRequests = new Map<string, Promise<VoiceRtcConfig>>()

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

export async function getVoiceRtcConfig(
  forceRefresh = false,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VoiceRtcConfig> {
  const cacheKey = httpClient.getServerUrl()

  if (cachedVoiceRtcConfigs.has(cacheKey) && !forceRefresh) {
    return cachedVoiceRtcConfigs.get(cacheKey) ?? DEFAULT_VOICE_RTC_CONFIG
  }

  const pendingRequest = voiceRtcConfigRequests.get(cacheKey)
  if (pendingRequest && !forceRefresh) {
    return pendingRequest
  }

  const request = (async () => {
    try {
      const response = await httpClient.apiFetch('/api/v1/voice/config')
      if (!response.ok) {
        cachedVoiceRtcConfigs.set(cacheKey, DEFAULT_VOICE_RTC_CONFIG)
        return DEFAULT_VOICE_RTC_CONFIG
      }

      const payload = await response.json()
      const normalized = normalizeVoiceRtcConfig(payload)
      cachedVoiceRtcConfigs.set(cacheKey, normalized)
      return normalized
    } catch {
      cachedVoiceRtcConfigs.set(cacheKey, DEFAULT_VOICE_RTC_CONFIG)
      return DEFAULT_VOICE_RTC_CONFIG
    } finally {
      voiceRtcConfigRequests.delete(cacheKey)
    }
  })()

  voiceRtcConfigRequests.set(cacheKey, request)
  return request
}
