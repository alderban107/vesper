import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import type { GroupState } from './mls.js'
import { exportGroupInfo, verifyPublicGroupSnapshot } from './mls.js'

const WRAPPING_VERSION = 1
const EXPORTER_LABEL = 'vesper-cohort-wrapping-v1'

export interface CohortWrappingContext {
  roomId: string
  cohortId: string
  groupId: string
  topologyGeneration: number
  mlsEpoch: number
}

export interface CohortWrappingPublication extends CohortWrappingContext {
  version: 1
  publicKey: Uint8Array
  signerIdentity: string
  signerPublicKey: Uint8Array
  groupInfoDigest: Uint8Array
  signature: Uint8Array
}

export interface DerivedCohortWrappingKey {
  privateKey: Uint8Array
  publication: CohortWrappingPublication
}

function contextBytes(context: CohortWrappingContext): Uint8Array {
  return new TextEncoder().encode(
    [
      `version=${WRAPPING_VERSION}`,
      `room=${context.roomId}`,
      `cohort=${context.cohortId}`,
      `group=${context.groupId}`,
      `topology=${context.topologyGeneration}`,
      `epoch=${context.mlsEpoch}`
    ].join('\n')
  )
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function signingBytes(publication: Omit<CohortWrappingPublication, 'signature'>): Uint8Array {
  return new TextEncoder().encode(
    [
      new TextDecoder().decode(contextBytes(publication)),
      `public_key=${hex(publication.publicKey)}`,
      `signer=${publication.signerIdentity}`,
      `signer_key=${hex(publication.signerPublicKey)}`,
      `group_info=${hex(publication.groupInfoDigest)}`
    ].join('\n')
  )
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource))
}

export async function deriveCohortWrappingKey(
  state: GroupState,
  context: CohortWrappingContext,
  publishedGroupInfo: Uint8Array = exportGroupInfo(state)
): Promise<DerivedCohortWrappingKey> {
  if (state._group.group_id() !== context.groupId) {
    throw new Error('wrapping context group does not match MLS state')
  }
  if (Number(state.groupContext.epoch) !== context.mlsEpoch) {
    throw new Error('wrapping context epoch does not match MLS state')
  }

  const privateKey = new Uint8Array(
    state._group.export_secret(state._provider, EXPORTER_LABEL, contextBytes(context), 32)
  )
  const publicKey = x25519.getPublicKey(privateKey)
  const signerIdentity = state._identity.name()
  const signerPublicKey = new Uint8Array(state._identity.signature_public_key())
  const groupInfoDigest = await sha256(publishedGroupInfo)
  const unsigned: Omit<CohortWrappingPublication, 'signature'> = {
    version: WRAPPING_VERSION,
    ...context,
    publicKey,
    signerIdentity,
    signerPublicKey,
    groupInfoDigest
  }
  const signature = new Uint8Array(state._identity.sign(signingBytes(unsigned)))

  return {
    privateKey,
    publication: { ...unsigned, signature }
  }
}

export async function verifyCohortWrappingPublication(
  expected: CohortWrappingContext,
  publication: CohortWrappingPublication,
  publishedGroupInfo: Uint8Array,
  publishedRatchetTree: Uint8Array
): Promise<boolean> {
  if (
    publication.version !== WRAPPING_VERSION ||
    publication.roomId !== expected.roomId ||
    publication.cohortId !== expected.cohortId ||
    publication.groupId !== expected.groupId ||
    publication.topologyGeneration !== expected.topologyGeneration ||
    publication.mlsEpoch !== expected.mlsEpoch ||
    publication.publicKey.byteLength !== 32 ||
    publication.signerPublicKey.byteLength !== 32 ||
    publication.signature.byteLength !== 64
  ) {
    return false
  }

  const currentGroupInfoDigest = await sha256(publishedGroupInfo)
  if (!equalBytes(currentGroupInfoDigest, publication.groupInfoDigest)) {
    return false
  }

  let publicGroup
  try {
    publicGroup = verifyPublicGroupSnapshot(publishedGroupInfo, publishedRatchetTree)
  } catch {
    return false
  }
  if (publicGroup.groupId !== expected.groupId || publicGroup.epoch !== expected.mlsEpoch) {
    return false
  }

  const signerIsMember = publicGroup.members.some(
    (identity) =>
      identity.name === publication.signerIdentity &&
      equalBytes(identity.signaturePublicKey, publication.signerPublicKey)
  )
  if (!signerIsMember) {
    return false
  }

  const { signature: _signature, ...unsigned } = publication
  return ed25519.verify(publication.signature, signingBytes(unsigned), publication.signerPublicKey)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
