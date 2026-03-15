#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Running client web push gate..."
(
  cd "$repo_root/client"
  npm run check:web
)

echo "Pre-push checks passed."
