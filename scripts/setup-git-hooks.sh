#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

git -C "$repo_root" config core.hooksPath .githooks

echo "Git hooks enabled from $repo_root/.githooks"
echo "Configured hooks: pre-commit, pre-push"
