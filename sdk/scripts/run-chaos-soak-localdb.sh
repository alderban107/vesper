#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$PACKAGE_DIR/../.." && pwd)"

. "$REPO_ROOT/scripts/load-test-env.sh" "$REPO_ROOT"

"$SCRIPT_DIR/start-test-postgres.sh"

cd "$REPO_ROOT"
npm --prefix sdk run build
node sdk/scripts/run-chaos-soak.mjs
