import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import ipaddr from 'ipaddr.js'

import {
  isBlockedLinkPreviewUrl,
  parseLinkPreview,
  type LinkPreviewData
} from '../shared/linkPreview'

const LINK_PREVIEW_TIMEOUT_MS = 5_000
const MAX_LINK_PREVIEW_HTML_BYTES = 524_288
const MAX_LINK_PREVIEW_REDIRECTS = 5

interface ResolvedAddress {
  address: string
  family: number
}

interface PinnedResponse {
  status: number
  location: string | null
  contentType: string
  body: Uint8Array
}

export interface LinkPreviewFetchDependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  request?: (
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal
  ) => Promise<PinnedResponse>
}

export function isPrivateIpAddress(rawAddress: string): boolean {
  try {
    // `process` normalizes IPv4-mapped IPv6 before classifying it. Permit only
    // ordinary globally routable unicast addresses; transition, translation,
    // documentation, local, multicast, and reserved ranges all fail closed.
    return ipaddr.process(rawAddress).range() !== 'unicast'
  } catch {
    return true
  }
}

export async function fetchLinkPreviewMetadata(
  rawUrl: string,
  dependencies: LinkPreviewFetchDependencies = {}
): Promise<LinkPreviewData | null> {
  const resolve = dependencies.resolve ?? resolveHostname
  const request = dependencies.request ?? requestPinnedUrl
  const signal = AbortSignal.timeout(LINK_PREVIEW_TIMEOUT_MS)
  let currentUrl = parseSafeHttpUrl(rawUrl)
  if (!currentUrl) {
    return null
  }

  try {
    for (let redirects = 0; redirects <= MAX_LINK_PREVIEW_REDIRECTS; redirects += 1) {
      const addresses = await resolve(currentUrl.hostname)
      if (
        addresses.length === 0 ||
        addresses.some((entry) => isPrivateIpAddress(entry.address))
      ) {
        return null
      }

      const response = await request(currentUrl, addresses[0], signal)
      if (isRedirectStatus(response.status)) {
        if (redirects === MAX_LINK_PREVIEW_REDIRECTS || !response.location) {
          return null
        }

        const redirected = parseSafeHttpUrl(response.location, currentUrl)
        if (!redirected) {
          return null
        }
        currentUrl = redirected
        continue
      }

      if (response.status < 200 || response.status >= 300) {
        return null
      }
      if (
        (!response.contentType.includes('text/html') &&
          !response.contentType.includes('application/xhtml+xml')) ||
        response.body.byteLength > MAX_LINK_PREVIEW_HTML_BYTES
      ) {
        return null
      }

      return parseLinkPreview(new TextDecoder().decode(response.body), currentUrl.toString())
    }
  } catch {
    return null
  }

  return null
}

async function resolveHostname(hostname: string): Promise<ResolvedAddress[]> {
  return await dnsLookup(hostname, { all: true })
}

function parseSafeHttpUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      isBlockedLinkPreviewUrl(url.toString())
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

async function requestPinnedUrl(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal
): Promise<PinnedResponse> {
  return await new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: url.protocol === 'https:' ? url.hostname : undefined,
        headers: {
          Host: url.host,
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Vesper-LinkPreview/1.0'
        },
        signal
      },
      async (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location ?? null
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase()

        if (isRedirectStatus(status)) {
          response.resume()
          resolve({ status, location, contentType, body: new Uint8Array() })
          return
        }

        const declaredLength = Number(response.headers['content-length'] ?? 0)
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_LINK_PREVIEW_HTML_BYTES
        ) {
          response.destroy()
          reject(new Error('link preview body too large'))
          return
        }

        const chunks: Uint8Array[] = []
        let byteLength = 0
        try {
          for await (const chunk of response) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)
            byteLength += bytes.byteLength
            if (byteLength > MAX_LINK_PREVIEW_HTML_BYTES) {
              response.destroy()
              throw new Error('link preview body too large')
            }
            chunks.push(bytes)
          }

          const body = new Uint8Array(byteLength)
          let offset = 0
          for (const chunk of chunks) {
            body.set(chunk, offset)
            offset += chunk.byteLength
          }
          resolve({ status, location, contentType, body })
        } catch (error) {
          reject(error)
        }
      }
    )
    req.on('error', reject)
    req.end()
  })
}
