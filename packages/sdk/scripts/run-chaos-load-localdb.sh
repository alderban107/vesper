#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

"$SCRIPT_DIR/start-test-postgres.sh"

export TEST_DB_USER="${TEST_DB_USER:-${VESPER_SDK_TEST_DB_USER:-vesper_sdk}}"
export TEST_DB_PASS="${TEST_DB_PASS:-${VESPER_SDK_TEST_DB_PASS:-vesper_sdk}}"
export TEST_DB_HOST="${TEST_DB_HOST:-127.0.0.1}"
export TEST_DB_PORT="${TEST_DB_PORT:-${VESPER_SDK_TEST_DB_PORT:-55432}}"

cd "$PACKAGE_DIR"
npm run build
node scripts/run-chaos-load.mjs
