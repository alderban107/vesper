import type { RoomKeyEnvelope } from '../crypto/roomKeys.js'
import { getDefaultHttpClient, type VesperHttpClient } from './client.js'
import { base64ToUint8, uint8ToBase64 } from './encoding.js'

type RoomTopologyMode = 'single' | 'batched_single' | 'multi_cohort'
type RoomTopologyState =
  | 'preparing'
  | 'cohorts_ready'
  | 'room_key_ready'
  | 'cutover_appended'
  | 'active'
  | 'rolled_back'
type RoomKeyEpochState = 'preparing' | 'staged' | 'active' | 'repair' | 'retired'
type RoomKeyReason =
  | 'initial'
  | 'membership_change'
  | 'topology_change'
  | 'wrapping_key_rotation'
  | 'repair'
  | 'policy'

interface RoomTopologyWire {
  topology_id: string
  room_id: string
  mode: RoomTopologyMode
  generation: number
  target_cohort_size: number
  state: 'cutover_appended' | 'active'
  cutover_room_seq?: number | null
  cohort_id?: string | null
  cohort_ordinal?: number | null
  cohort_member_count?: number | null
  group_id: string
}

interface RoomTopologyMigrationWire {
  id: string
  room_id: string
  generation: number
  mode: 'multi_cohort'
  state: RoomTopologyState
  request_id: string
  previous_topology_id?: string | null
  cutover_room_seq?: number | null
  failure_reason?: string | null
}

interface CohortWrappingKeyWire {
  mls_epoch: number
  public_key: string
  signature: string
  signer_identity: string
  signer_public_key: string
  group_info_digest: string
}

interface RoomKeyEnvelopeWire {
  cohort_id: string
  group_id: string
  wrapping_mls_epoch: number
  ephemeral_public_key: string
  nonce: string
  ciphertext: string
  aad_digest: string
}

interface RoomKeyEpochWire {
  id: string
  room_id: string
  topology_generation: number
  epoch: number
  state: RoomKeyEpochState
  reason: string
  request_id: string
  fencing_token: number
  expected_cohort_count: number
  repair_reason?: string | null
  envelopes?: RoomKeyEnvelopeWire[]
}

interface RoomKeyMaterialWire {
  topology: { room_id: string; generation: number }
  cohorts: Array<{
    cohort_id: string
    group_id: string
    ordinal: number
    wrapping_key: CohortWrappingKeyWire | null
  }>
}

export interface RoomCryptoTopologyResolution {
  topologyId: string
  roomId: string
  mode: RoomTopologyMode
  generation: number
  targetCohortSize: number
  state: 'cutover_appended' | 'active'
  cutoverRoomSeq: number | null
  cohortId: string | null
  cohortOrdinal: number | null
  cohortMemberCount: number | null
  groupId: string
}

export interface RoomTopologyMigration {
  id: string
  roomId: string
  generation: number
  mode: 'multi_cohort'
  state: RoomTopologyState
  requestId: string
  previousTopologyId: string | null
  cutoverRoomSeq: number | null
  failureReason: string | null
}

export interface StoredCohortWrappingPublication {
  groupId: string
  topologyGeneration: number
  mlsEpoch: number
  publicKey: Uint8Array
  signature: Uint8Array
  signerIdentity: string
  signerPublicKey: Uint8Array
  groupInfoDigest: Uint8Array
}

export interface RoomKeyEpochRecord {
  id: string
  roomId: string
  topologyGeneration: number
  epoch: number
  state: RoomKeyEpochState
  reason: string
  requestId: string
  fencingToken: number
  expectedCohortCount: number
  repairReason: string | null
  envelopes: RoomKeyEnvelope[]
}

export interface RoomKeyCohortMaterial {
  cohortId: string
  groupId: string
  ordinal: number
  wrappingKey: StoredCohortWrappingPublication | null
}

export interface RoomKeyCoordinationMaterial {
  roomId: string
  topologyGeneration: number
  cohorts: RoomKeyCohortMaterial[]
}

export interface PreparedRoomKeyEpoch {
  epoch: RoomKeyEpochRecord
  material: RoomKeyCoordinationMaterial
}

export async function fetchRoomCryptoTopology(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient(),
  topologyId?: string
): Promise<RoomCryptoTopologyResolution> {
  const query = topologyId ? `?topology_id=${encodeURIComponent(topologyId)}` : ''
  const response = await httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${encodeURIComponent(scopeId)}${query}`
  )
  if (!response.ok) {
    throw new Error(`Could not resolve room crypto topology: ${response.status}`)
  }

  const body = (await response.json()) as { topology: RoomTopologyWire }
  return decodeTopology(body.topology)
}

export async function prepareRoomTopologyMigration(
  scopeId: string,
  requestId: string,
  targetCohortSize: number,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomTopologyMigration> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${encodeURIComponent(scopeId)}/prepare`,
    {
      method: 'POST',
      body: JSON.stringify({
        mode: 'multi_cohort',
        target_cohort_size: targetCohortSize,
        request_id: requestId
      })
    }
  )
  if (!response.ok) {
    throw new Error(`Could not prepare room topology migration: ${response.status}`)
  }

  const body = (await response.json()) as { migration: RoomTopologyMigrationWire }
  return decodeTopologyMigration(body.migration)
}

export async function cutoverRoomTopologyMigration(
  scopeId: string,
  topologyId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomCryptoTopologyResolution> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${encodeURIComponent(scopeId)}/cutover`,
    { method: 'POST', body: JSON.stringify({ topology_id: topologyId }) }
  )
  if (!response.ok) {
    throw new Error(`Could not cut over room topology: ${response.status}`)
  }

  const body = (await response.json()) as { topology: RoomTopologyWire }
  return decodeTopology(body.topology)
}

export async function rollbackRoomTopologyMigration(
  scopeId: string,
  topologyId: string,
  reason: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomTopologyMigration> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${encodeURIComponent(scopeId)}/rollback`,
    { method: 'POST', body: JSON.stringify({ topology_id: topologyId, reason }) }
  )
  if (!response.ok) {
    throw new Error(`Could not roll back room topology: ${response.status}`)
  }

  const body = (await response.json()) as { migration: RoomTopologyMigrationWire }
  return decodeTopologyMigration(body.migration)
}

export async function publishCohortWrappingKey(
  publication: StoredCohortWrappingPublication,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const response = await httpClient.apiFetch(
    `/api/v1/cohort-wrapping-keys/${encodeURIComponent(publication.groupId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        topology_generation: publication.topologyGeneration,
        mls_epoch: publication.mlsEpoch,
        public_key: uint8ToBase64(publication.publicKey),
        signature: uint8ToBase64(publication.signature),
        signer_identity: publication.signerIdentity,
        signer_public_key: uint8ToBase64(publication.signerPublicKey),
        group_info_digest: uint8ToBase64(publication.groupInfoDigest)
      })
    }
  )
  if (!response.ok) {
    throw new Error(`Could not publish cohort wrapping key: ${response.status}`)
  }
}

export async function fetchCohortWrappingKey(
  groupId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<StoredCohortWrappingPublication | null> {
  const response = await httpClient.apiFetch(
    `/api/v1/cohort-wrapping-keys/${encodeURIComponent(groupId)}`
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Could not fetch cohort wrapping key: ${response.status}`)
  }

  const body = (await response.json()) as { wrapping_key: CohortWrappingKeyWire & { group_id: string; topology_generation: number } }
  const key = body.wrapping_key
  return {
    groupId: key.group_id,
    topologyGeneration: key.topology_generation,
    mlsEpoch: key.mls_epoch,
    publicKey: base64ToUint8(key.public_key),
    signature: base64ToUint8(key.signature),
    signerIdentity: key.signer_identity,
    signerPublicKey: base64ToUint8(key.signer_public_key),
    groupInfoDigest: base64ToUint8(key.group_info_digest)
  }
}

export async function prepareRoomKeyEpoch(
  scopeId: string,
  requestId: string,
  reason: RoomKeyReason,
  httpClient: VesperHttpClient = getDefaultHttpClient(),
  topologyId?: string
): Promise<PreparedRoomKeyEpoch> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-key-epochs/${encodeURIComponent(scopeId)}/prepare`,
    {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, reason, topology_id: topologyId })
    }
  )
  if (!response.ok) {
    throw new Error(`Could not prepare room-key epoch: ${response.status}`)
  }

  const body = (await response.json()) as RoomKeyMaterialWire & { room_key_epoch: RoomKeyEpochWire }
  return {
    epoch: decodeRoomKeyEpoch(body.room_key_epoch),
    material: decodeRoomKeyMaterial(body)
  }
}

export async function claimRoomKeyEpoch(
  epochId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord> {
  return requestRoomKeyEpoch(
    `/api/v1/room-key-epoch/${encodeURIComponent(epochId)}/claim`,
    { method: 'POST' },
    'claim room-key epoch',
    httpClient
  )
}

export async function renewRoomKeyEpoch(
  epochId: string,
  fencingToken: number,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord> {
  return requestRoomKeyEpoch(
    `/api/v1/room-key-epoch/${encodeURIComponent(epochId)}/renew`,
    { method: 'POST', body: JSON.stringify({ fencing_token: fencingToken }) },
    'renew room-key epoch',
    httpClient
  )
}

export async function putRoomKeyEnvelope(
  epochId: string,
  cohortId: string,
  fencingToken: number,
  envelope: RoomKeyEnvelope,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-key-epoch/${encodeURIComponent(epochId)}/envelopes/${encodeURIComponent(cohortId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        fencing_token: fencingToken,
        group_id: envelope.groupId,
        wrapping_mls_epoch: envelope.wrappingMlsEpoch,
        ephemeral_public_key: uint8ToBase64(envelope.ephemeralPublicKey),
        nonce: uint8ToBase64(envelope.nonce),
        ciphertext: uint8ToBase64(envelope.ciphertext),
        aad_digest: uint8ToBase64(envelope.aadDigest)
      })
    }
  )
  if (!response.ok) {
    throw new Error(`Could not store room-key envelope: ${response.status}`)
  }
}

export async function stageRoomKeyEpoch(
  epochId: string,
  fencingToken: number,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord> {
  return completeRoomKeyEpoch(epochId, fencingToken, 'stage', httpClient)
}

export async function activateRoomKeyEpoch(
  epochId: string,
  fencingToken: number,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord> {
  return completeRoomKeyEpoch(epochId, fencingToken, 'activate', httpClient)
}

export async function reportRoomKeyEpochRepair(
  epochId: string,
  reason: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-key-epoch/${encodeURIComponent(epochId)}/repair`,
    { method: 'POST', body: JSON.stringify({ reason }) }
  )
  if (!response.ok) {
    throw new Error(`Could not report room-key repair: ${response.status}`)
  }
}

export async function fetchRoomKeyEpoch(
  scopeId: string,
  epoch: number,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord | null> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error('Room-key epoch must be a non-negative safe integer')
  }

  const response = await httpClient.apiFetch(
    `/api/v1/room-key-epochs/${encodeURIComponent(scopeId)}/${epoch}`
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Could not fetch room-key epoch ${epoch}: ${response.status}`)
  }

  const body = (await response.json()) as { room_key_epoch: RoomKeyEpochWire }
  return decodeRoomKeyEpoch(body.room_key_epoch)
}

export async function fetchActiveRoomKeyEpoch(
  scopeId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<RoomKeyEpochRecord | null> {
  const response = await httpClient.apiFetch(
    `/api/v1/room-key-epochs/${encodeURIComponent(scopeId)}/active`
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Could not fetch active room-key epoch: ${response.status}`)
  }

  const body = (await response.json()) as { room_key_epoch: RoomKeyEpochWire }
  return decodeRoomKeyEpoch(body.room_key_epoch)
}

function decodeTopology(value: RoomTopologyWire): RoomCryptoTopologyResolution {
  return {
    topologyId: value.topology_id,
    roomId: value.room_id,
    mode: value.mode,
    generation: value.generation,
    targetCohortSize: value.target_cohort_size,
    state: value.state,
    cutoverRoomSeq: value.cutover_room_seq ?? null,
    cohortId: value.cohort_id ?? null,
    cohortOrdinal: value.cohort_ordinal ?? null,
    cohortMemberCount: value.cohort_member_count ?? null,
    groupId: value.group_id
  }
}

function decodeTopologyMigration(value: RoomTopologyMigrationWire): RoomTopologyMigration {
  return {
    id: value.id,
    roomId: value.room_id,
    generation: value.generation,
    mode: value.mode,
    state: value.state,
    requestId: value.request_id,
    previousTopologyId: value.previous_topology_id ?? null,
    cutoverRoomSeq: value.cutover_room_seq ?? null,
    failureReason: value.failure_reason ?? null
  }
}

async function requestRoomKeyEpoch(
  path: string,
  init: RequestInit,
  operation: string,
  httpClient: VesperHttpClient
): Promise<RoomKeyEpochRecord> {
  const response = await httpClient.apiFetch(path, init)
  if (!response.ok) {
    throw new Error(`Could not ${operation}: ${response.status}`)
  }
  const body = (await response.json()) as { room_key_epoch: RoomKeyEpochWire }
  return decodeRoomKeyEpoch(body.room_key_epoch)
}

function completeRoomKeyEpoch(
  epochId: string,
  fencingToken: number,
  operation: 'stage' | 'activate',
  httpClient: VesperHttpClient
): Promise<RoomKeyEpochRecord> {
  return requestRoomKeyEpoch(
    `/api/v1/room-key-epoch/${encodeURIComponent(epochId)}/${operation}`,
    { method: 'POST', body: JSON.stringify({ fencing_token: fencingToken }) },
    `${operation} room-key epoch`,
    httpClient
  )
}

function decodeRoomKeyMaterial(body: RoomKeyMaterialWire): RoomKeyCoordinationMaterial {
  return {
    roomId: body.topology.room_id,
    topologyGeneration: body.topology.generation,
    cohorts: body.cohorts.map((entry) => ({
      cohortId: entry.cohort_id,
      groupId: entry.group_id,
      ordinal: entry.ordinal,
      wrappingKey: entry.wrapping_key
        ? {
            groupId: entry.group_id,
            topologyGeneration: body.topology.generation,
            mlsEpoch: entry.wrapping_key.mls_epoch,
            publicKey: base64ToUint8(entry.wrapping_key.public_key),
            signature: base64ToUint8(entry.wrapping_key.signature),
            signerIdentity: entry.wrapping_key.signer_identity,
            signerPublicKey: base64ToUint8(entry.wrapping_key.signer_public_key),
            groupInfoDigest: base64ToUint8(entry.wrapping_key.group_info_digest)
          }
        : null
    }))
  }
}

function decodeRoomKeyEpoch(value: RoomKeyEpochWire): RoomKeyEpochRecord {
  return {
    id: value.id,
    roomId: value.room_id,
    topologyGeneration: value.topology_generation,
    epoch: value.epoch,
    state: value.state,
    reason: value.reason,
    requestId: value.request_id,
    fencingToken: value.fencing_token,
    expectedCohortCount: value.expected_cohort_count,
    repairReason: value.repair_reason ?? null,
    envelopes: (value.envelopes ?? []).map((entry) => ({
      version: 1,
      roomId: value.room_id,
      topologyGeneration: value.topology_generation,
      roomKeyEpoch: value.epoch,
      cohortId: entry.cohort_id,
      groupId: entry.group_id,
      wrappingMlsEpoch: entry.wrapping_mls_epoch,
      ephemeralPublicKey: base64ToUint8(entry.ephemeral_public_key),
      nonce: base64ToUint8(entry.nonce),
      ciphertext: base64ToUint8(entry.ciphertext),
      aadDigest: base64ToUint8(entry.aad_digest)
    }))
  }
}
