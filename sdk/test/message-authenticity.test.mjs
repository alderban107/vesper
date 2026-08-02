import assert from 'node:assert/strict'
import test from 'node:test'

import { ed25519 } from '@noble/curves/ed25519.js'

import { uint8ToBase64 } from '../dist/api/encoding.js'
import {
  messageHistorySigningBytes,
  verifyHistoryBundlePlaintext,
  withMessageHistoryAuthentication
} from '../dist/client/messageAuthenticity.js'

function authenticatedPlaintext({ text = 'authentic body', nonce = 'nonce-1' } = {}) {
  const scopeId = 'scope-1'
  const privateKey = new Uint8Array(32).fill(7)
  const publicKey = ed25519.getPublicKey(privateKey)
  const payload = { v: 1, type: 'text', text }
  const binding = { type: 'client_nonce', value: nonce, revision: 0 }
  const signature = ed25519.sign(
    messageHistorySigningBytes(scopeId, binding, payload),
    privateKey
  )
  const authenticated = withMessageHistoryAuthentication(payload, {
    v: 1,
    scope_id: scopeId,
    binding_type: binding.type,
    binding: binding.value,
    revision: binding.revision,
    signer_public_key: uint8ToBase64(publicKey),
    signature: uint8ToBase64(signature)
  })

  return {
    scopeId,
    plaintext: JSON.stringify(authenticated),
    authoritative: {
      id: 'message-1',
      sender_id: 'sender-1',
      sender: {
        id: 'sender-1',
        username: 'sender'
      },
      client_nonce: nonce,
      history_signing_public_key: uint8ToBase64(publicKey),
      history_revision: 0,
      inserted_at: new Date(0).toISOString()
    }
  }
}

test('history plaintext is bound to the authoritative sender key, scope, and nonce', () => {
  const fixture = authenticatedPlaintext()
  assert.equal(
    verifyHistoryBundlePlaintext(
      fixture.plaintext,
      fixture.scopeId,
      fixture.authoritative
    ),
    true
  )

  assert.equal(
    verifyHistoryBundlePlaintext(
      fixture.plaintext.replace('authentic body', 'forged body'),
      fixture.scopeId,
      fixture.authoritative
    ),
    false
  )
  assert.equal(
    verifyHistoryBundlePlaintext(
      fixture.plaintext,
      fixture.scopeId,
      { ...fixture.authoritative, client_nonce: 'other-nonce' }
    ),
    false
  )
  assert.equal(
    verifyHistoryBundlePlaintext(
      fixture.plaintext,
      fixture.scopeId,
      { ...fixture.authoritative, history_revision: 1 }
    ),
    false,
    'an edited authoritative row must reject a valid pre-edit signature'
  )
})
