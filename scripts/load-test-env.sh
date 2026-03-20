#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: . load-test-env.sh <repo-root>" >&2
  return 1 2>/dev/null || exit 1
fi

REPO_ROOT="$1"
ENV_FILE="${VESPER_ENV_FILE:-$REPO_ROOT/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

TEST_DB_HOST="${TEST_DB_HOST:-${VESPER_SDK_TEST_DB_HOST:-127.0.0.1}}"
TEST_DB_PORT="${TEST_DB_PORT:-${VESPER_SDK_TEST_DB_PORT:-55432}}"
TEST_DB_USER="${TEST_DB_USER:-${VESPER_SDK_TEST_DB_USER:-vesper_sdk}}"
TEST_DB_PASS="${TEST_DB_PASS:-${VESPER_SDK_TEST_DB_PASS:-vesper_sdk}}"

export TEST_DB_HOST
export TEST_DB_PORT
export TEST_DB_USER
export TEST_DB_PASS

export VESPER_SDK_TEST_DB_HOST="${VESPER_SDK_TEST_DB_HOST:-$TEST_DB_HOST}"
export VESPER_SDK_TEST_DB_PORT="${VESPER_SDK_TEST_DB_PORT:-$TEST_DB_PORT}"
export VESPER_SDK_TEST_DB_USER="${VESPER_SDK_TEST_DB_USER:-$TEST_DB_USER}"
export VESPER_SDK_TEST_DB_PASS="${VESPER_SDK_TEST_DB_PASS:-$TEST_DB_PASS}"
export VESPER_SDK_TEST_DB_CONTAINER="${VESPER_SDK_TEST_DB_CONTAINER:-vesper-sdk-test-postgres}"
export VESPER_SDK_TEST_DB_VOLUME="${VESPER_SDK_TEST_DB_VOLUME:-vesper-sdk-test-postgres-data}"
export VESPER_SDK_TEST_DB_IMAGE="${VESPER_SDK_TEST_DB_IMAGE:-postgres:16-alpine}"
export VESPER_SDK_TEST_DB_PROFILE="${VESPER_SDK_TEST_DB_PROFILE:-tuned}"
