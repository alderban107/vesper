import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomCryptoState } from '../dist/client/roomCryptoState.js'

const scope = { id: 'conversation-1', channelId: 'room-1' }
const topology = {
  topologyId: 'topology-1',
  roomId: 'internal-room-1',
  mode: 'multi_cohort',
  generation: 2,
  targetCohortSize: 512,
  state: 'active',
  cutoverRoomSeq: 4,
  cohortId: 'cohort-1',
  cohortOrdinal: 0,
  cohortMemberCount: 2,
  groupId: 'group-1'
}

test('room crypto state destroys topology and decrypted keys on session reset', () => {
  const state = new RoomCryptoState()
  const key = Uint8Array.from({ length: 32 }, (_, index) => index)

  state.rememberTopology(scope, topology)
  state.rememberDataKey(topology.roomId, 3, key)

  assert.equal(state.groupId(scope), topology.groupId)
  assert.deepEqual(state.dataKey(topology.roomId, 3), key)

  state.clear()

  assert.equal(state.topology(scope), null)
  assert.equal(state.groupId(scope), scope.channelId)
  assert.equal(state.dataKey(topology.roomId, 3), null)
})

test('room crypto state copies key bytes and bounds retained epochs', () => {
  const state = new RoomCryptoState()
  const source = new Uint8Array([1, 2, 3])

  state.rememberDataKey(topology.roomId, 1, source)
  source[0] = 9
  assert.deepEqual(state.dataKey(topology.roomId, 1), new Uint8Array([1, 2, 3]))

  const returned = state.dataKey(topology.roomId, 1)
  returned[1] = 9
  assert.deepEqual(state.dataKey(topology.roomId, 1), new Uint8Array([1, 2, 3]))

  for (let epoch = 2; epoch <= 10; epoch += 1) {
    state.rememberDataKey(topology.roomId, epoch, new Uint8Array([epoch]))
  }

  assert.equal(state.dataKey(topology.roomId, 1), null)
  assert.deepEqual(state.dataKey(topology.roomId, 3), new Uint8Array([3]))
  assert.deepEqual(state.dataKey(topology.roomId, 10), new Uint8Array([10]))
})
