/**
 * Deterministic test data for all E2E scenarios.
 * Covers: Test Data Requirements section
 */

export const USERS = {
  alice: { username: 'alice_e2e', password: 'AlicePass!2024secure' },
  bob: { username: 'bob_e2e', password: 'BobPass!2024secure' },
  charlie: { username: 'charlie_e2e', password: 'CharliePass!2024secure' },
} as const

export const SERVER = {
  name: 'Vesper E2E Server',
} as const

export const CHANNELS = {
  general: 'general-e2e',
  random: 'random-e2e',
  voice: 'voice-e2e',
} as const

export const CUSTOM_EMOJI = {
  name: 'testfire',
  // 1x1 orange PNG (smallest valid PNG)
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
} as const

/** Unique message bodies so search/assertions can target them directly. */
export const DM_MESSAGES = {
  aliceToBob1: 'Hey Bob, this is Alice — DM test alpha',
  aliceToBob2: 'Second message from Alice — DM test bravo',
  bobToAlice1: 'Hi Alice! Bob here — DM test charlie',
  bobToAlice2: 'Another from Bob — DM test delta',
  threadReply1: 'Thread reply one — DM thread echo',
  threadReply2: 'Thread reply two — DM thread foxtrot',
} as const

export const CHANNEL_MESSAGES = {
  alice1: 'Channel msg from Alice — chan test golf',
  bob1: 'Channel msg from Bob — chan test hotel',
  charlie1: 'Channel msg from Charlie — chan test india',
  alice2: 'Follow-up from Alice — chan test juliet',
  threadReply1: 'Channel thread reply — chan thread kilo',
  threadReply2: 'Channel thread reply two — chan thread lima',
  editOriginal: 'This message will be edited — chan edit mike',
  editUpdated: 'This message has been edited — chan edit november',
  deleteTarget: 'This message will be deleted — chan delete oscar',
  pinTarget: 'This message gets pinned — chan pin papa',
  disappearing: 'This will disappear — chan ttl quebec',
  searchTarget: 'Unique searchable string xQ7vZ9 for test',
  mentionTest: 'Hey @alice_e2e check this out — chan mention romeo',
  emojiInBody: 'Check out this emoji :testfire: inline',
} as const

export const REACTIONS = {
  thumbsUp: '👍',
  heart: '❤️',
} as const

export const ATTACHMENT = {
  fileName: 'test-upload.txt',
  content: 'Vesper E2E test attachment content — unique id xR8wK3',
  mimeType: 'text/plain',
} as const
