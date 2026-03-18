#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${TEST_DB_HOST:-}" ]]; then
  export TEST_DB_HOST="${VESPER_SDK_TEST_DB_HOST:-localhost}"
fi

if [[ -z "${TEST_DB_PORT:-}" ]]; then
  export TEST_DB_PORT="${VESPER_SDK_TEST_DB_PORT:-55432}"
fi

if [[ -z "${TEST_DB_USER:-}" ]]; then
  export TEST_DB_USER="${VESPER_SDK_TEST_DB_USER:-vesper_sdk}"
fi

if [[ -z "${TEST_DB_PASS:-}" ]]; then
  export TEST_DB_PASS="${VESPER_SDK_TEST_DB_PASS:-vesper_sdk}"
fi

if command -v docker >/dev/null 2>&1; then
  sh "$repo_root/packages/sdk/scripts/start-test-postgres.sh" >/dev/null
fi

echo "Running server precommit checks..."
(
  cd "$repo_root/server"
  mix precommit
)

echo "Running client web checks..."
(
  cd "$repo_root/client"
  npm run check:web
)

echo "Pre-commit checks passed."
