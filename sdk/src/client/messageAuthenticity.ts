import { ed25519 } from '@noble/curves/ed25519.js'

import { base64ToUint8 } from '../api/encoding.js'
import type { MessagePayload, MessageHistoryAuthentication } from '../crypto/payload.js'
import type { VesperMessage } from '../api/chat.js'

export type MessageHistoryBinding =
  | { type: 'client_nonce'; value: string; revision: 0 }
  | { type: 'message_id'; value: string; revision: number }

export function messageHistorySigningBytes(
  scopeId: string,
  binding: MessageHistoryBinding,
  payload: MessagePayload
): Uint8Array {
  const unsignedPayload = withoutMessageHistoryAuthentication(payload)
  return new TextEncoder().encode(
    `vesper.message-history.v1\n${scopeId}\n${binding.type}\n${binding.value}\n${binding.revision}\n${JSON.stringify(unsignedPayload)}`
  )
}

export function withMessageHistoryAuthentication(
  payload: MessagePayload,
  authentication: MessageHistoryAuthentication
): MessagePayload {
  return {
    ...withoutMessageHistoryAuthentication(payload),
    history_auth: authentication
  } as MessagePayload
}

export function withoutMessageHistoryAuthentication(payload: MessagePayload): MessagePayload {
  const { history_auth: _authentication, ...unsigned } = payload
  return unsigned as MessagePayload
}

export function verifyHistoryBundlePlaintext(
  plaintext: string,
  scopeId: string,
  authoritativeMessage: VesperMessage
): boolean {
  let payload: MessagePayload
  try {
    payload = JSON.parse(plaintext) as MessagePayload
  } catch {
    return false
  }

  const authentication = payload?.history_auth
  const authoritativeSigningKey = authoritativeMessage.history_signing_public_key
  if (
    !authentication ||
    authentication.v !== 1 ||
    authentication.scope_id !== scopeId ||
    !Number.isSafeInteger(authentication.revision) ||
    authentication.revision !== authoritativeMessage.history_revision ||
    typeof authentication.signer_public_key !== 'string' ||
    authentication.signer_public_key !== authoritativeSigningKey ||
    typeof authentication.signature !== 'string' ||
    typeof authoritativeSigningKey !== 'string'
  ) {
    return false
  }

  const binding = authoritativeBinding(authentication, authoritativeMessage)
  if (!binding) {
    return false
  }

  try {
    const signature = base64ToUint8(authentication.signature)
    const publicKey = base64ToUint8(authoritativeSigningKey)
    return signature.byteLength === 64 &&
      publicKey.byteLength === 32 &&
      ed25519.verify(signature, messageHistorySigningBytes(scopeId, binding, payload), publicKey)
  } catch {
    return false
  }
}

function authoritativeBinding(
  authentication: MessageHistoryAuthentication,
  message: VesperMessage
): MessageHistoryBinding | null {
  if (
    authentication.binding_type === 'client_nonce' &&
    authentication.revision === 0 &&
    typeof message.client_nonce === 'string' &&
    message.client_nonce.length > 0 &&
    authentication.binding === message.client_nonce
  ) {
    return { type: 'client_nonce', value: message.client_nonce, revision: 0 }
  }

  if (
    authentication.binding_type === 'message_id' &&
    authentication.revision > 0 &&
    authentication.binding === message.id
  ) {
    return { type: 'message_id', value: message.id, revision: authentication.revision }
  }

  return null
}
