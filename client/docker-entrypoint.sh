#!/bin/sh
if [ -n "${API_URL:-}" ]; then
  escaped_api_url=$(printf '%s' "$API_URL" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) printf "\\n"; printf "%s", $0 }')
  api_url="\"${escaped_api_url}\""
else
  api_url="window.location.origin"
fi

cat > /usr/share/nginx/html/config.js <<EOF
window.VESPER_API_URL = ${api_url};
EOF
exec "$@"
