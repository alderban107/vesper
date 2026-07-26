import { execFileSync } from 'node:child_process'
import process from 'node:process'

function psqlJson(stack, sql, variables = {}) {
  const args = [
    '-h', process.env.TEST_DB_HOST ?? '127.0.0.1',
    '-p', process.env.TEST_DB_PORT ?? '55432',
    '-U', process.env.TEST_DB_USER ?? 'vesper_sdk',
    '-d', stack.dbName,
    '-X', '-q', '-t', '-A'
  ]

  for (const [key, value] of Object.entries(variables)) {
    args.push('-v', `${key}=${value}`)
  }

  const output = execFileSync('psql', args, {
    env: {
      ...process.env,
      PGPASSWORD: process.env.TEST_DB_PASS ?? 'vesper_sdk'
    },
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit']
  }).trim()

  return JSON.parse(output)
}

function summarizePlan(explain) {
  const root = explain[0]
  const totals = {
    planningTimeMs: root['Planning Time'] ?? null,
    executionTimeMs: root['Execution Time'] ?? null,
    sharedHitBlocks: 0,
    sharedReadBlocks: 0,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    scannedRows: 0,
    rowsRemovedByFilter: 0,
    heapFetches: 0,
    indexProbeLoops: 0,
    planRows: root.Plan?.['Plan Rows'] ?? null,
    actualRows: root.Plan?.['Actual Rows'] ?? null,
    nodes: []
  }

  function walk(node) {
    if (!node) return
    totals.sharedHitBlocks += node['Shared Hit Blocks'] ?? 0
    totals.sharedReadBlocks += node['Shared Read Blocks'] ?? 0
    totals.tempReadBlocks += node['Temp Read Blocks'] ?? 0
    totals.tempWrittenBlocks += node['Temp Written Blocks'] ?? 0
    totals.rowsRemovedByFilter +=
      (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1)
    totals.heapFetches += node['Heap Fetches'] ?? 0
    if (String(node['Node Type'] ?? '').includes('Scan')) {
      totals.scannedRows += (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1)
    }
    if (String(node['Node Type'] ?? '').includes('Index')) {
      totals.indexProbeLoops += node['Actual Loops'] ?? 0
    }
    totals.nodes.push({
      nodeType: node['Node Type'],
      relationName: node['Relation Name'] ?? null,
      indexName: node['Index Name'] ?? null,
      actualRows: node['Actual Rows'] ?? null,
      loops: node['Actual Loops'] ?? null,
      rowsRemovedByFilter: node['Rows Removed by Filter'] ?? 0
    })
    for (const child of node.Plans ?? []) walk(child)
  }

  walk(root.Plan)
  return totals
}

export function profileDatabase(stack, userId, pageSize, historyPageSize, fixture) {
  const variables = {
    profile_user_id: userId,
    profile_limit: pageSize + 1,
    profile_history_limit: historyPageSize,
    profile_busy_group_id: fixture.busy_group_conversation_id,
    profile_busy_channel_id: fixture.busy_server_channel_id
  }
  const dmPage = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
WITH user_conversations AS MATERIALIZED (
  SELECT p.conversation_id
  FROM dm_participants p
  WHERE p.user_id = :'profile_user_id'
)
SELECT r.conversation_id, r.activity_at
FROM user_conversations p
JOIN rooms r ON r.conversation_id = p.conversation_id
WHERE r.kind = 'dm'
ORDER BY r.activity_at DESC, r.conversation_id DESC
LIMIT :profile_limit;
`, variables)

  const servers = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT s.id, s.name, s.icon_url, s.owner_id, s.inserted_at, s.updated_at
FROM servers s
JOIN memberships m ON m.server_id = s.id
WHERE m.user_id = :'profile_user_id'
ORDER BY s.inserted_at ASC;
`, variables)

  const scopeDelta = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT events.*
FROM (
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN memberships m ON m.user_id = :'profile_user_id' AND m.server_id = e.scope_id
    WHERE e.scope_kind = 'server'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) server_events
  UNION ALL
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN channels c ON c.id = e.scope_id
    JOIN memberships m ON m.user_id = :'profile_user_id' AND m.server_id = c.server_id
    WHERE e.scope_kind = 'channel'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) channel_events
  UNION ALL
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN dm_participants p
      ON p.user_id = :'profile_user_id' AND p.conversation_id = e.scope_id
    WHERE e.scope_kind = 'dm'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) dm_events
) events
ORDER BY events.id ASC
LIMIT :profile_limit;
`, variables)

  const dmHistoryPage = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT m.id, m.inserted_at, m.ciphertext, e.room_seq, u.id AS sender_id
FROM messages m
LEFT JOIN room_events e ON e.message_id = m.id
JOIN users u ON u.id = m.sender_id
WHERE m.conversation_id = :'profile_busy_group_id'
ORDER BY m.inserted_at DESC, m.id DESC
LIMIT :profile_history_limit;
`, variables)

  const channelHistoryPage = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT m.id, m.inserted_at, m.ciphertext, e.room_seq, u.id AS sender_id
FROM messages m
LEFT JOIN room_events e ON e.message_id = m.id
JOIN users u ON u.id = m.sender_id
WHERE m.channel_id = :'profile_busy_channel_id'
ORDER BY m.inserted_at DESC, m.id DESC
LIMIT :profile_history_limit;
`, variables)

  const storage = psqlJson(stack, `
SELECT json_build_object(
  'message_count', (SELECT count(*) FROM messages),
  'room_event_count', (SELECT count(*) FROM room_events),
  'messages_bytes', pg_total_relation_size('messages'),
  'room_events_bytes', pg_total_relation_size('room_events'),
  'combined_bytes', pg_total_relation_size('messages') + pg_total_relation_size('room_events')
);
`, variables)

  return {
    dmPage: { summary: summarizePlan(dmPage), explain: dmPage },
    servers: { summary: summarizePlan(servers), explain: servers },
    scopeDelta: { summary: summarizePlan(scopeDelta), explain: scopeDelta },
    dmHistoryPage: { summary: summarizePlan(dmHistoryPage), explain: dmHistoryPage },
    channelHistoryPage: {
      summary: summarizePlan(channelHistoryPage),
      explain: channelHistoryPage
    },
    storage
  }
}
