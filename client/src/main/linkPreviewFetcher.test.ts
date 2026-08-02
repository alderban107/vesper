import { describe, expect, it, vi } from 'vitest'

import { fetchLinkPreviewMetadata, isPrivateIpAddress } from './linkPreviewFetcher'

const publicAddress = { address: '93.184.216.34', family: 4 }

function htmlResponse(html: string) {
  return {
    status: 200,
    location: null,
    contentType: 'text/html; charset=utf-8',
    body: new TextEncoder().encode(html)
  }
}

describe('link preview network boundary', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::7f00:1',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '5f00::1',
    'not-an-address'
  ])('rejects private or reserved address %s', (address) => {
    expect(isPrivateIpAddress(address)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPrivateIpAddress(address)).toBe(false)
    }
  )

  it('rejects mixed public/private DNS answers before opening a socket', async () => {
    const request = vi.fn()
    const result = await fetchLinkPreviewMetadata('https://example.com', {
      resolve: async () => [publicAddress, { address: '127.0.0.1', family: 4 }],
      request
    })

    expect(result).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('revalidates every redirect target and never requests a private hop', async () => {
    const resolve = vi.fn(async (hostname: string) =>
      hostname === 'internal.example'
        ? [{ address: '10.0.0.8', family: 4 }]
        : [publicAddress]
    )
    const request = vi.fn(async () => ({
      status: 302,
      location: 'https://internal.example/admin',
      contentType: 'text/html',
      body: new Uint8Array()
    }))

    const result = await fetchLinkPreviewMetadata('https://public.example/start', {
      resolve,
      request
    })

    expect(result).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('pins the validated address into the request and uses the final redirect URL', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        location: '/article',
        contentType: 'text/html',
        body: new Uint8Array()
      })
      .mockResolvedValueOnce(
        htmlResponse(
          '<html><head><title>Safe title</title><meta name="description" content="Safe description"></head></html>'
        )
      )

    const result = await fetchLinkPreviewMetadata('https://example.com/start', {
      resolve: async () => [publicAddress],
      request
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1]).toEqual(publicAddress)
    expect(request.mock.calls[1][0].toString()).toBe('https://example.com/article')
    expect(result).toMatchObject({
      url: 'https://example.com/article',
      title: 'Safe title',
      description: 'Safe description'
    })
  })

  it('rejects oversized response bodies even from an injected transport', async () => {
    const result = await fetchLinkPreviewMetadata('https://example.com', {
      resolve: async () => [publicAddress],
      request: async () => ({
        status: 200,
        location: null,
        contentType: 'text/html',
        body: new Uint8Array(524_289)
      })
    })

    expect(result).toBeNull()
  })

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:password@example.com/',
    'http://localhost/',
    'http://[::1]/'
  ])('rejects unsafe URL %s before DNS resolution', async (url) => {
    const resolve = vi.fn(async () => [publicAddress])
    expect(await fetchLinkPreviewMetadata(url, { resolve })).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })
})
