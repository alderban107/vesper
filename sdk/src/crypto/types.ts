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

/** Recovery key data returned during registration */
export interface RecoveryKeyData {
  mnemonic: string
  hash: string
  encryptedBundle: Uint8Array
  bundleNonce: Uint8Array
}
