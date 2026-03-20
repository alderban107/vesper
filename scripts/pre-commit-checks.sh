#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

. "$repo_root/scripts/load-test-env.sh" "$repo_root"

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
