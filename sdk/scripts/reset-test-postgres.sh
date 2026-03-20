#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

. "$REPO_ROOT/scripts/load-test-env.sh" "$REPO_ROOT"

if docker ps -a --format '{{.Names}}' | grep -qx "$VESPER_SDK_TEST_DB_CONTAINER"; then
  docker rm -f "$VESPER_SDK_TEST_DB_CONTAINER" >/dev/null
  echo "Removed container '$VESPER_SDK_TEST_DB_CONTAINER'."
fi

if docker volume inspect "$VESPER_SDK_TEST_DB_VOLUME" >/dev/null 2>&1; then
  docker volume rm -f "$VESPER_SDK_TEST_DB_VOLUME" >/dev/null
  echo "Removed volume '$VESPER_SDK_TEST_DB_VOLUME'."
fi
