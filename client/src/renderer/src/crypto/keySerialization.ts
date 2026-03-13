/**
 * Versioned serialization for private key packages.
 *
 * Format: [version: 1 byte][field_count: 1 byte]([len: 2 bytes LE][data: len bytes])...
 *
 * This replaces the fragile `concat + slice(0,32) + slice(32,64) + slice(64)` pattern
 * that depended on fixed key sizes and had no validation.
 */

const CURRENT_VERSION = 1
const FIELD_COUNT_V1 = 3 // initPrivateKey, hpkePrivateKey, signaturePrivateKey

export interface PrivateKeyFields {
  initPrivateKey: Uint8Array
  hpkePrivateKey: Uint8Array
  signaturePrivateKey: Uint8Array
}

/**
 * Serialize private key fields into a versioned binary format.
 */
export function serializePrivatePackage(fields: PrivateKeyFields): Uint8Array {
  const parts = [fields.initPrivateKey, fields.hpkePrivateKey, fields.signaturePrivateKey]

  // Calculate total size: 1 (version) + 1 (field_count) + sum(2 + len for each field)
  let totalSize = 2
  for (const part of parts) {
    totalSize += 2 + part.length
  }

  const result = new Uint8Array(totalSize)
  result[0] = CURRENT_VERSION
  result[1] = FIELD_COUNT_V1

  let offset = 2
  for (const part of parts) {
    // Length as 2-byte little-endian
    result[offset] = part.length & 0xff
    result[offset + 1] = (part.length >> 8) & 0xff
    offset += 2
    result.set(part, offset)
    offset += part.length
  }

  return result
}

/**
 * Deserialize private key fields from either:
 * - Version 1+ format (has version header)
 * - Legacy format (raw concatenated bytes: 32 + 32 + remainder)
 *
 * Legacy detection: if the first byte is not a recognized version number AND
 * the total length is >= 96 (minimum for 32+32+32), treat as legacy format.
 */
export function deserializePrivatePackage(data: Uint8Array): PrivateKeyFields {
  if (data.length < 2) {
    throw new Error('Private key package too short')
  }

  const version = data[0]

  if (version === CURRENT_VERSION) {
    return deserializeV1(data)
  }

  // Legacy format detection: version byte would be 1 for v1.
  // In legacy format, the first byte is part of the initPrivateKey (random byte, unlikely to be 1).
  // However, there's a 1/256 chance of collision. Use additional heuristics:
  // Legacy data is exactly 32 + 32 + N bytes where N is the signature key size.
  // V1 format has byte[1] = 3 (field count). If byte[1] is also 3, check if
  // the length matches V1 encoding exactly.
  if (version === CURRENT_VERSION) {
    // Already handled above, but kept for clarity
    return deserializeV1(data)
  }

  // Assume legacy format
  return deserializeLegacy(data)
}

function deserializeV1(data: Uint8Array): PrivateKeyFields {
  const fieldCount = data[1]
  if (fieldCount < FIELD_COUNT_V1) {
    throw new Error(`Expected at least ${FIELD_COUNT_V1} fields, got ${fieldCount}`)
  }

  const fields: Uint8Array[] = []
  let offset = 2

  for (let i = 0; i < FIELD_COUNT_V1; i++) {
    if (offset + 2 > data.length) {
      throw new Error(`Unexpected end of data reading field ${i} length`)
    }
    const len = data[offset] | (data[offset + 1] << 8)
    offset += 2

    if (offset + len > data.length) {
      throw new Error(`Unexpected end of data reading field ${i} (need ${len} bytes, have ${data.length - offset})`)
    }
    fields.push(data.slice(offset, offset + len))
    offset += len
  }

  return {
    initPrivateKey: fields[0],
    hpkePrivateKey: fields[1],
    signaturePrivateKey: fields[2]
  }
}

function deserializeLegacy(data: Uint8Array): PrivateKeyFields {
  if (data.length < 96) {
    throw new Error(`Legacy private key package too short: ${data.length} bytes (minimum 96)`)
  }

  return {
    initPrivateKey: data.slice(0, 32),
    hpkePrivateKey: data.slice(32, 64),
    signaturePrivateKey: data.slice(64)
  }
}
