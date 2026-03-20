#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

. "$REPO_ROOT/scripts/load-test-env.sh" "$REPO_ROOT"

CONTAINER_NAME="${VESPER_SDK_TEST_DB_CONTAINER:-vesper-sdk-test-postgres}"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Stopped '$CONTAINER_NAME'."
  exit 0
fi

echo "No container named '$CONTAINER_NAME' is running."
