#!/bin/sh
set -eu

CONTAINER_NAME="${VESPER_SDK_TEST_DB_CONTAINER:-vesper-sdk-test-postgres}"
PORT="${VESPER_SDK_TEST_DB_PORT:-55432}"
USER_NAME="${VESPER_SDK_TEST_DB_USER:-vesper_sdk}"
PASSWORD="${VESPER_SDK_TEST_DB_PASS:-vesper_sdk}"
DB_NAME="${VESPER_SDK_TEST_DB_NAME:-postgres}"
IMAGE="${VESPER_SDK_TEST_DB_IMAGE:-postgres:16-alpine}"
VOLUME_NAME="${VESPER_SDK_TEST_DB_VOLUME:-vesper-sdk-test-postgres-data}"
PG_TUNE_PROFILE="${VESPER_SDK_TEST_DB_PROFILE:-tuned}"

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Postgres container '$CONTAINER_NAME' is already running on port $PORT."
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  docker volume create "$VOLUME_NAME" >/dev/null
fi

set -- "$IMAGE"

if [ "$PG_TUNE_PROFILE" = "tuned" ]; then
  set -- "$IMAGE" \
    postgres \
    -c shared_buffers=256MB \
    -c effective_cache_size=768MB \
    -c work_mem=16MB \
    -c maintenance_work_mem=128MB \
    -c max_connections=200 \
    -c synchronous_commit=off \
    -c wal_compression=on \
    -c random_page_cost=1.1
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_USER="$USER_NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$PORT:5432" \
  -v "$VOLUME_NAME:/var/lib/postgresql/data" \
  "$@" >/dev/null

ATTEMPTS=0
until docker exec "$CONTAINER_NAME" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    echo "Postgres container '$CONTAINER_NAME' did not become ready." >&2
    exit 1
  fi
  sleep 1
done

echo "Postgres container '$CONTAINER_NAME' is ready on port $PORT."
