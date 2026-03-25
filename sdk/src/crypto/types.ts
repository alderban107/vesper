import type { GroupState, KeyPackagePair } from './mls.js'

// Re-export the new types from mls.ts
export type { GroupState, KeyPackagePair }

/** Identity key pair for signing and key exchange */
export interface IdentityKeys {
  signatureKeyPair: {
    publicKey: Uint8Array
    privateKey: Uint8Array
  }
}

/** Encrypted key bundle stored on the server */
export interface EncryptedKeyBundle {
  ciphertext: Uint8Array
  nonce: Uint8Array
  salt: Uint8Array
}

/** Serializable MLS group info for persistence */
export interface MLSGroupInfo {
  groupId: string
  state: Uint8Array
  epoch: number
}

/** Result of encrypting an application message */
export interface EncryptedMessage {
  ciphertext: Uint8Array
  epoch: number
  newState: GroupState
}

/** Result of decrypting an application message */
export interface DecryptedMessage {
  plaintext: string
  newState: GroupState
}

/** Recovery key data returned during registration */
export interface RecoveryKeyData {
  mnemonic: string
  hash: string
  encryptedBundle: Uint8Array
  bundleNonce: Uint8Array
}
