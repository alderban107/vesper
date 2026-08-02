#!/bin/sh
set -eu

case "${PUBLIC_SCHEME:-http}" in
  http|https) ;;
  *)
    echo "PUBLIC_SCHEME must be http or https" >&2
    exit 1
    ;;
esac

sed "s/__VESPER_PUBLIC_SCHEME__/${PUBLIC_SCHEME:-http}/g" \
  /etc/nginx/vesper/proxy_headers.inc.template > /tmp/proxy_headers.inc

exec "$@"
