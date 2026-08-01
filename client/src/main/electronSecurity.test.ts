import { describe, expect, it } from 'vitest'

import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  normalizeHttpOrigin,
  secureWebPreferences
} from './electronSecurity'

describe('Electron renderer boundary', () => {
  it('enforces sandboxing and disables renderer Node privileges', () => {
    expect(secureWebPreferences('/trusted/preload.js')).toMatchObject({
      preload: '/trusted/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('canonicalizes only credential-free HTTP(S) server origins', () => {
    expect(normalizeHttpOrigin('https://vesper.example:8443/api/v1')).toBe(
      'https://vesper.example:8443'
    )
    expect(normalizeHttpOrigin('https://user:secret@vesper.example')).toBeNull()
    expect(normalizeHttpOrigin('file:///tmp/server')).toBeNull()
  })

  it.each([
    ['https://example.com/path', true],
    ['http://example.com/path', true],
    ['mailto:security@example.com', true],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['data:text/html,unsafe', false],
    ['not a url', false]
  ])('classifies external target %s', (url, expected) => {
    expect(isAllowedExternalUrl(url)).toBe(expected)
  })

  it('allows only the current web origin or exact packaged renderer file', () => {
    expect(
      isAllowedRendererNavigation(
        'https://app.vesper.example/channels/1',
        'https://app.vesper.example/settings'
      )
    ).toBe(true)
    expect(
      isAllowedRendererNavigation(
        'https://app.vesper.example/channels/1',
        'https://attacker.example/'
      )
    ).toBe(false)
    expect(
      isAllowedRendererNavigation(
        'file:///opt/Vesper/resources/app.asar/out/renderer/index.html#/channel/1',
        'file:///opt/Vesper/resources/app.asar/out/renderer/index.html#/settings'
      )
    ).toBe(true)
    expect(
      isAllowedRendererNavigation(
        'file:///opt/Vesper/resources/app.asar/out/renderer/index.html',
        'file:///etc/passwd'
      )
    ).toBe(false)
  })
})
