#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

. "$REPO_ROOT/scripts/load-test-env.sh" "$REPO_ROOT"

CONTAINER_NAME="${VESPER_SDK_TEST_DB_CONTAINER:-vesper-sdk-test-postgres}"
HOST_NAME="${VESPER_SDK_TEST_DB_HOST:-${TEST_DB_HOST:-127.0.0.1}}"
PORT_NUMBER="${VESPER_SDK_TEST_DB_PORT:-${TEST_DB_PORT:-55432}}"
USER_NAME="${VESPER_SDK_TEST_DB_USER:-${TEST_DB_USER:-vesper_sdk}}"
PASSWORD="${VESPER_SDK_TEST_DB_PASS:-${TEST_DB_PASS:-vesper_sdk}}"
DB_NAME="${VESPER_SDK_PROFILE_DB_NAME:-}"
DATABASE_URL="${DATABASE_URL:-}"
MODE=""

if [ -n "$DATABASE_URL" ]; then
  MODE="url"
elif pg_isready -h "$HOST_NAME" -p "$PORT_NUMBER" >/dev/null 2>&1; then
  MODE="direct"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  MODE="docker"
else
  echo "No PostgreSQL service is available through DATABASE_URL, $HOST_NAME:$PORT_NUMBER, or container '$CONTAINER_NAME'." >&2
  exit 1
fi

if [ -z "$DB_NAME" ] && [ "$MODE" != "url" ]; then
  if [ "$MODE" = "direct" ]; then
    DB_NAME="$(
      PGPASSWORD="$PASSWORD" psql -h "$HOST_NAME" -p "$PORT_NUMBER" -U "$USER_NAME" -d postgres -Atc \
        "SELECT datname
         FROM pg_database
         WHERE datname LIKE 'vesper_test_sdk_%'
         ORDER BY datname DESC
         LIMIT 1"
    )"
  else
    DB_NAME="$(
      docker exec -e PGPASSWORD="$PASSWORD" "$CONTAINER_NAME" \
        psql -U "$USER_NAME" -d postgres -Atc \
        "SELECT datname
         FROM pg_database
         WHERE datname LIKE 'vesper_test_sdk_%'
         ORDER BY datname DESC
         LIMIT 1"
    )"
  fi
fi

if [ "$MODE" != "url" ] && [ -z "$DB_NAME" ]; then
  echo "No sdk test database found. Run an integration, chaos, or account profile scenario first." >&2
  exit 1
fi

run_psql() {
  case "$MODE" in
    url)
      psql "$DATABASE_URL" "$@"
      ;;
    direct)
      PGPASSWORD="$PASSWORD" psql -h "$HOST_NAME" -p "$PORT_NUMBER" -U "$USER_NAME" -d "$DB_NAME" "$@"
      ;;
    docker)
      docker exec -i -e PGPASSWORD="$PASSWORD" "$CONTAINER_NAME" psql -U "$USER_NAME" -d "$DB_NAME" "$@"
      ;;
  esac
}

if [ "$MODE" = "url" ]; then
  echo "Profiling database from DATABASE_URL"
else
  echo "Profiling database: $DB_NAME"
fi

run_psql <<'SQL'
\timing on

\echo ''
\echo 'Latest-message path'
EXPLAIN (ANALYZE, BUFFERS)
WITH hot_room AS (
  SELECT id, channel_id, last_message_id, last_message_seq
  FROM rooms
  WHERE channel_id IS NOT NULL
    AND last_message_id IS NOT NULL
  ORDER BY current_seq DESC
  LIMIT 1
)
SELECT m.id, hot_room.last_message_seq
FROM hot_room
JOIN messages AS m ON m.id = hot_room.last_message_id;

\echo ''
\echo 'Message restore after_seq path'
EXPLAIN (ANALYZE, BUFFERS)
WITH hot_room AS (
  SELECT id, channel_id, GREATEST(COALESCE(last_message_seq, 0) - 64, 0) AS after_seq
  FROM rooms
  WHERE channel_id IS NOT NULL
    AND last_message_seq IS NOT NULL
  ORDER BY current_seq DESC
  LIMIT 1
)
SELECT m.id, re.room_seq
FROM hot_room
JOIN room_events AS re
  ON re.room_id = hot_room.id
JOIN messages AS m
  ON m.id = re.message_id
WHERE m.channel_id = hot_room.channel_id
  AND re.room_seq > hot_room.after_seq
ORDER BY re.room_seq ASC
LIMIT 80;

\echo ''
\echo 'Mutation replay after_seq path'
EXPLAIN (ANALYZE, BUFFERS)
WITH hot_room AS (
  SELECT id, GREATEST(COALESCE(last_mutation_seq, 0) - 32, 0) AS after_seq
  FROM rooms
  WHERE last_mutation_seq IS NOT NULL
  ORDER BY current_seq DESC
  LIMIT 1
)
SELECT re.id, re.room_seq, re.event_type
FROM hot_room
JOIN room_events AS re
  ON re.room_id = hot_room.id
WHERE re.event_type != 'vesper.message'
  AND re.room_seq > hot_room.after_seq
ORDER BY re.room_seq ASC
LIMIT 120;
SQL
