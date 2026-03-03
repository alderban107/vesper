#!/bin/sh
cat > /usr/share/nginx/html/config.js <<EOF
window.VESPER_API_URL = "${API_URL:-}";
EOF
exec "$@"
