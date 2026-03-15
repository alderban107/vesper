#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
