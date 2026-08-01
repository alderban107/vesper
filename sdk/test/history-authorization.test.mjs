import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applicationHistoryIncludesRoomSeq,
  normalizeApplicationHistoryAuthorization
} from '../dist/client/historyAuthorization.js'

test('application history authorization uses an exclusive room-sequence boundary', () => {
  const authorization = normalizeApplicationHistoryAuthorization('membership-generation', 12)
  assert.ok(authorization)

  assert.equal(applicationHistoryIncludesRoomSeq(authorization, 11), false)
  assert.equal(applicationHistoryIncludesRoomSeq(authorization, 12), false)
  assert.equal(applicationHistoryIncludesRoomSeq(authorization, 13), true)
})

test('application history authorization fails closed for malformed server metadata', () => {
  assert.equal(normalizeApplicationHistoryAuthorization('', 0), null)
  assert.equal(normalizeApplicationHistoryAuthorization('generation', -1), null)
  assert.equal(normalizeApplicationHistoryAuthorization('generation', 1.5), null)
  assert.equal(normalizeApplicationHistoryAuthorization(null, 0), null)
})

test('application history authorization rejects missing or unsafe room sequences', () => {
  const authorization = normalizeApplicationHistoryAuthorization('membership-generation', 0)
  assert.ok(authorization)

  assert.equal(applicationHistoryIncludesRoomSeq(authorization, null), false)
  assert.equal(applicationHistoryIncludesRoomSeq(authorization, Number.MAX_SAFE_INTEGER + 1), false)
  assert.equal(applicationHistoryIncludesRoomSeq(authorization, 1), true)
})
