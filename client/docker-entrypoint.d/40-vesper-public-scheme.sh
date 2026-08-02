#!/bin/sh
set -eu

case "${PUBLIC_SCHEME:-http}" in
  http|https) ;;
  *)
    echo "PUBLIC_SCHEME must be http or https" >&2
    exit 1
    ;;
esac

sed -i "s/__VESPER_PUBLIC_SCHEME__/${PUBLIC_SCHEME:-http}/g" /etc/nginx/conf.d/proxy_headers.inc
