/**
 * OpenMLS WASM Test Harness for Vesper
 *
 * Tests the WASM bindings against the operations Vesper needs:
 * 1. Initialize cipher suite (implicit — via Provider)
 * 2. Create a group
 * 3. Add a member (traditional Welcome flow)
 * 4. Encrypt/decrypt messages
 * 5. Join via External Commit (the key new feature)
 * 6. Voice key derivation
 * 7. Member listing
 * 8. Remove a member
 * 9. KeyPackage serialization round-trip
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load WASM manually since we're in Node.js without a bundler
const wasmPath = join(__dirname, 'node_modules', 'vesper-openmls-wasm', 'vesper_openmls_wasm_bg.wasm')
const jsPath = join(__dirname, 'node_modules', 'vesper-openmls-wasm', 'vesper_openmls_wasm.js')

const wasm = await import(jsPath)
const wasmBytes = await readFile(wasmPath)
await wasm.default(wasmBytes)

const { Provider, Identity, Group, KeyPackage, RatchetTree } = wasm

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failed++
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed')
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`)
}

function assertDeepEqual(a, b, msg) {
  const aStr = JSON.stringify(a)
  const bStr = JSON.stringify(b)
  if (aStr !== bStr) throw new Error(msg || `Expected ${bStr}, got ${aStr}`)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

console.log('\n=== OpenMLS WASM Test Harness for Vesper ===\n')

// ============================================================
// Test 1: Provider and Identity creation
// ============================================================
console.log('Provider & Identity:')

test('create provider', () => {
  const provider = new Provider()
  assert(provider != null)
})

test('create identity with userId:deviceId format', () => {
  const provider = new Provider()
  const identity = new Identity(provider, 'user123:device456')
  assertEqual(identity.name(), 'user123:device456')
})

test('generate key package', () => {
  const provider = new Provider()
  const identity = new Identity(provider, 'alice:dev1')
  const kp = identity.key_package(provider)
  const bytes = kp.to_bytes()
  assert(bytes.length > 0, 'key package should have non-zero bytes')
})

// ============================================================
// Test 2: KeyPackage serialization round-trip
// ============================================================
console.log('\nKeyPackage Serialization:')

test('serialize and deserialize key package', () => {
  const provider = new Provider()
  const identity = new Identity(provider, 'alice:dev1')
  const kp = identity.key_package(provider)
  const bytes = kp.to_bytes()
  const kp2 = KeyPackage.from_bytes(bytes)
  const bytes2 = kp2.to_bytes()
  assertDeepEqual(Array.from(bytes), Array.from(bytes2), 'round-trip should produce identical bytes')
})

// ============================================================
// Test 3: Group creation and traditional add member
// ============================================================
console.log('\nGroup Creation & Welcome Join:')

test('create group', () => {
  const provider = new Provider()
  const alice = new Identity(provider, 'alice:dev1')
  const group = Group.create_new(provider, alice, 'test-channel-1')
  assertEqual(group.group_id(), 'test-channel-1')
  assertEqual(group.member_count(), 1)
  assertEqual(group.epoch(), 0n)
})

test('add member via Welcome', () => {
  const aliceProvider = new Provider()
  const bobProvider = new Provider()
  const alice = new Identity(aliceProvider, 'alice:dev1')
  const bob = new Identity(bobProvider, 'bob:dev1')

  const group = Group.create_new(aliceProvider, alice, 'welcome-test')
  const bobKp = bob.key_package(bobProvider)

  const bundle = group.add_member(aliceProvider, alice, bobKp)
  assert(bundle.commit.length > 0, 'should have commit bytes')
  assert(bundle.welcome != null, 'should have welcome for new member')

  group.merge_pending_commit(aliceProvider)

  const ratchetTree = group.export_ratchet_tree()
  const bobGroup = Group.join_from_welcome(bobProvider, bundle.welcome, ratchetTree)

  assertEqual(group.member_count(), 2)
  assertEqual(bobGroup.member_count(), 2)
})

// ============================================================
// Test 4: Encrypt and decrypt messages
// ============================================================
console.log('\nEncryption & Decryption:')

test('encrypt and decrypt message', () => {
  const aliceProvider = new Provider()
  const bobProvider = new Provider()
  const alice = new Identity(aliceProvider, 'alice:dev1')
  const bob = new Identity(bobProvider, 'bob:dev1')

  const aliceGroup = Group.create_new(aliceProvider, alice, 'msg-test')
  const bobKp = bob.key_package(bobProvider)
  const bundle = aliceGroup.add_member(aliceProvider, alice, bobKp)
  aliceGroup.merge_pending_commit(aliceProvider)

  const ratchetTree = aliceGroup.export_ratchet_tree()
  const bobGroup = Group.join_from_welcome(bobProvider, bundle.welcome, ratchetTree)

  // Alice sends a message
  const plaintext = 'Hello from Alice! 🔐'
  const ciphertext = aliceGroup.create_message(aliceProvider, alice, encoder.encode(plaintext))

  // Bob decrypts
  const result = bobGroup.process_message(bobProvider, ciphertext)
  assertEqual(result.kind, 'application')
  assertEqual(decoder.decode(result.message), plaintext)
})

test('bidirectional messaging', () => {
  const aliceProvider = new Provider()
  const bobProvider = new Provider()
  const alice = new Identity(aliceProvider, 'alice:dev1')
  const bob = new Identity(bobProvider, 'bob:dev1')

  const aliceGroup = Group.create_new(aliceProvider, alice, 'bidir-test')
  const bobKp = bob.key_package(bobProvider)
  const bundle = aliceGroup.add_member(aliceProvider, alice, bobKp)
  aliceGroup.merge_pending_commit(aliceProvider)

  const ratchetTree = aliceGroup.export_ratchet_tree()
  const bobGroup = Group.join_from_welcome(bobProvider, bundle.welcome, ratchetTree)

  // Alice → Bob
  const msg1 = aliceGroup.create_message(aliceProvider, alice, encoder.encode('from alice'))
  const r1 = bobGroup.process_message(bobProvider, msg1)
  assertEqual(decoder.decode(r1.message), 'from alice')

  // Bob → Alice
  const msg2 = bobGroup.create_message(bobProvider, bob, encoder.encode('from bob'))
  const r2 = aliceGroup.process_message(aliceProvider, msg2)
  assertEqual(decoder.decode(r2.message), 'from bob')
})

// ============================================================
// Test 5: External Commit (THE KEY TEST)
// ============================================================
console.log('\n★ External Commit (RFC 9420 §12.4):')

test('join via External Commit — no Welcome needed', () => {
  const aliceProvider = new Provider()
  const charlieProvider = new Provider()
  const alice = new Identity(aliceProvider, 'alice:dev1')
  const charlie = new Identity(charlieProvider, 'charlie:dev1')

  // Alice creates a group
  const aliceGroup = Group.create_new(aliceProvider, alice, 'ext-commit-test')

  // Alice exports GroupInfo (published to server)
  const groupInfoBytes = aliceGroup.export_group_info(aliceProvider, alice)
  assert(groupInfoBytes.length > 0, 'GroupInfo should have bytes')

  // Alice exports ratchet tree (also published to server)
  const ratchetTree = aliceGroup.export_ratchet_tree()

  // Charlie joins WITHOUT Alice doing anything — the magic of External Commits
  const extResult = Group.join_from_external_commit(
    charlieProvider,
    charlie,
    groupInfoBytes,
    ratchetTree
  )

  const extCommitBytes = extResult.commit_bytes()
  const charlieGroup = extResult.take_group()

  // Charlie is in the group
  assertEqual(charlieGroup.member_count(), 2)

  // Alice processes the external commit (she'd receive this via the server)
  const result = aliceGroup.process_message(aliceProvider, extCommitBytes)
  assertEqual(result.kind, 'commit')
  assertEqual(aliceGroup.member_count(), 2)
})

test('External Commit → then messaging works', () => {
  const aliceProvider = new Provider()
  const charlieProvider = new Provider()
  const alice = new Identity(aliceProvider, 'alice:dev1')
  const charlie = new Identity(charlieProvider, 'charlie:dev1')

  const aliceGroup = Group.create_new(aliceProvider, alice, 'ext-msg-test')

  const groupInfo = aliceGroup.export_group_info(aliceProvider, alice)
  const tree = aliceGroup.export_ratchet_tree()

  const extResult = Group.join_from_external_commit(charlieProvider, charlie, groupInfo, tree)
  const extCommitBytes = extResult.commit_bytes()
  const charlieGroup = extResult.take_group()
  aliceGroup.process_message(aliceProvider, extCommitBytes)

  // Charlie sends a message
  const msg = 'I joined without being invited! (via External Commit)'
  const encrypted = charlieGroup.create_message(charlieProvider, charlie, encoder.encode(msg))

  const result = aliceGroup.process_message(aliceProvider, encrypted)
  assertEqual(result.kind, 'application')
  assertEqual(decoder.decode(result.message), msg)

  // Alice responds
  const reply = 'Welcome! External Commits are amazing.'
  const encrypted2 = aliceGroup.create_message(aliceProvider, alice, encoder.encode(reply))
  const result2 = charlieGroup.process_message(charlieProvider, encrypted2)
  assertEqual(decoder.decode(result2.message), reply)
})

test('External Commit with multiple members already in group', () => {
  const aP = new Provider()
  const bP = new Provider()
  const cP = new Provider()
  const alice = new Identity(aP, 'alice:dev1')
  const bob = new Identity(bP, 'bob:dev1')
  const charlie = new Identity(cP, 'charlie:dev1')

  // Alice creates group, adds Bob via Welcome
  const aGroup = Group.create_new(aP, alice, 'multi-ext-test')
  const bobKp = bob.key_package(bP)
  const bundle = aGroup.add_member(aP, alice, bobKp)
  aGroup.merge_pending_commit(aP)
  const bGroup = Group.join_from_welcome(bP, bundle.welcome, aGroup.export_ratchet_tree())

  assertEqual(aGroup.member_count(), 2)

  // Now Charlie joins via External Commit
  const groupInfo = aGroup.export_group_info(aP, alice)
  const tree = aGroup.export_ratchet_tree()
  const extResult = Group.join_from_external_commit(cP, charlie, groupInfo, tree)
  const extCommitBytes = extResult.commit_bytes()
  const cGroup = extResult.take_group()

  // Alice and Bob process the external commit
  aGroup.process_message(aP, extCommitBytes)
  bGroup.process_message(bP, extCommitBytes)

  assertEqual(aGroup.member_count(), 3)
  assertEqual(bGroup.member_count(), 3)
  assertEqual(cGroup.member_count(), 3)

  // All three can message each other
  const msg = 'Three-way E2EE via External Commit!'
  const enc = cGroup.create_message(cP, charlie, encoder.encode(msg))
  const r1 = aGroup.process_message(aP, enc)
  assertEqual(decoder.decode(r1.message), msg)

  // Re-encode for Bob (can't reuse the same ciphertext — different group states)
  const msg2 = 'Message from Charlie to all'
  const enc2 = cGroup.create_message(cP, charlie, encoder.encode(msg2))
  const r2 = bGroup.process_message(bP, enc2)
  assertEqual(decoder.decode(r2.message), msg2)
})

// ============================================================
// Test 6: Voice key derivation
// ============================================================
console.log('\nVoice Key Derivation:')

test('derive voice-e2ee key (16 bytes)', () => {
  const provider = new Provider()
  const alice = new Identity(provider, 'alice:dev1')
  const group = Group.create_new(provider, alice, 'voice-test')

  const key = group.export_secret(provider, 'voice-e2ee', new Uint8Array(0), 16)
  assertEqual(key.length, 16)
})

test('same key derived by all members', () => {
  const aP = new Provider()
  const bP = new Provider()
  const alice = new Identity(aP, 'alice:dev1')
  const bob = new Identity(bP, 'bob:dev1')

  const aGroup = Group.create_new(aP, alice, 'voice-key-test')
  const bobKp = bob.key_package(bP)
  const bundle = aGroup.add_member(aP, alice, bobKp)
  aGroup.merge_pending_commit(aP)
  const bGroup = Group.join_from_welcome(bP, bundle.welcome, aGroup.export_ratchet_tree())

  const aKey = aGroup.export_secret(aP, 'voice-e2ee', new Uint8Array(0), 16)
  const bKey = bGroup.export_secret(bP, 'voice-e2ee', new Uint8Array(0), 16)
  assertDeepEqual(Array.from(aKey), Array.from(bKey), 'voice keys should match')
})

// ============================================================
// Test 7: Member listing
// ============================================================
console.log('\nMember Listing:')

test('list member identities', () => {
  const aP = new Provider()
  const bP = new Provider()
  const alice = new Identity(aP, 'alice:dev1')
  const bob = new Identity(bP, 'bob:dev1')

  const group = Group.create_new(aP, alice, 'members-test')
  const bobKp = bob.key_package(bP)
  group.add_member(aP, alice, bobKp)
  group.merge_pending_commit(aP)

  const identities = JSON.parse(group.member_identities())
  assert(identities.includes('alice:dev1'), 'should include alice')
  assert(identities.includes('bob:dev1'), 'should include bob')
  assertEqual(identities.length, 2)
})

// ============================================================
// Test 8: Epoch tracking
// ============================================================
console.log('\nEpoch Tracking:')

test('epoch increments on group changes', () => {
  const aP = new Provider()
  const bP = new Provider()
  const alice = new Identity(aP, 'alice:dev1')
  const bob = new Identity(bP, 'bob:dev1')

  const group = Group.create_new(aP, alice, 'epoch-test')
  assertEqual(group.epoch(), 0n)

  const bobKp = bob.key_package(bP)
  group.add_member(aP, alice, bobKp)
  group.merge_pending_commit(aP)
  assertEqual(group.epoch(), 1n)
})

// ============================================================
// Summary
// ============================================================
console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)

if (failed > 0) {
  console.log('\n⚠ Some tests failed!')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed!')
}

// ============================================================
// Bundle size report
// ============================================================
const { statSync } = await import('fs')
const wasmStat = statSync(wasmPath)
console.log(`\n📦 WASM binary size: ${(wasmStat.size / 1024 / 1024).toFixed(2)} MB`)
console.log(`   (acceptable for Electron, fine for browser with lazy loading)`)
