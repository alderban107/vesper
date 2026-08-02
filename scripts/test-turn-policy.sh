#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/turnserver.conf"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d /tmp/vesper-turn-policy.XXXXXX)}"
mkdir -p "$ARTIFACT_DIR"

TURN_IMAGE="${TURN_IMAGE:-$(
  awk '
    /^  coturn:$/ { in_coturn = 1; next }
    in_coturn && /^[[:space:]]+image:/ { print $2; exit }
  ' "$ROOT/docker-compose.yml"
)}"

if [[ -z "$TURN_IMAGE" || "$TURN_IMAGE" != *@sha256:* ]]; then
  echo "Could not resolve a digest-pinned coturn image from docker-compose.yml" >&2
  exit 1
fi

suffix="${GITHUB_RUN_ID:-$$}-${RANDOM}"
v4_network="vesper-turn-policy-v4-$suffix"
v6_network="vesper-turn-policy-v6-$suffix"
v4_server="vesper-turn-policy-v4-server-$suffix"
v6_server="vesper-turn-policy-v6-server-$suffix"
password="$(openssl rand -hex 32)"
transient_containers=()

cleanup() {
  docker rm -f "$v4_server" "$v6_server" "${transient_containers[@]}" >/dev/null 2>&1 || true
  docker network rm "$v4_network" "$v6_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_server() {
  local container="$1"
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] &&
       docker logs "$container" 2>&1 | grep -F 'listener opened on' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 2>&1 || true
  echo "TURN server $container did not become ready" >&2
  return 1
}

assert_config_parsed() {
  local container="$1"
  local log="$ARTIFACT_DIR/config-parse.log"
  docker logs "$container" >"$log" 2>&1

  if grep -Eq 'Bad configuration format|option is deprecated|ERROR: tls-listening-port' "$log"; then
    echo "coturn reported a malformed, deprecated, or inconsistent setting" >&2
    grep -E 'Bad configuration format|option is deprecated|ERROR: tls-listening-port' "$log" >&2
    return 1
  fi

  while IFS= read -r line; do
    local value="${line#denied-peer-ip=}"
    if ! grep -Fq "Black listing: $value" "$log"; then
      echo "coturn did not confirm parsing denied-peer-ip=$value" >&2
      return 1
    fi
  done < <(grep '^denied-peer-ip=' "$CONFIG")

  while IFS= read -r line; do
    local value="${line#allowed-peer-ip=}"
    if ! grep -Fq "White listing: $value" "$log"; then
      echo "coturn did not confirm parsing allowed-peer-ip=$value" >&2
      return 1
    fi
  done < <(grep '^allowed-peer-ip=' "$CONFIG")
}

run_positive_relay() {
  local network="$1"
  local server_ip="$2"
  local family_flag="$3"
  local label="$4"
  local log="$ARTIFACT_DIR/allow-$label.log"
  local client="vesper-turn-policy-allow-$label-$suffix"
  local -a family_args=()
  [[ -n "$family_flag" ]] && family_args+=("$family_flag")
  transient_containers+=("$client")

  set +e
  timeout 60 docker run --rm --name "$client" --network "$network" \
    --entrypoint turnutils_uclient "$TURN_IMAGE" \
    -u vesper -w "$password" -p 3478 "${family_args[@]}" -y -n 10 "$server_ip" >"$log" 2>&1
  local rc=$?
  set -e
  docker rm -f "$client" >/dev/null 2>&1 || true
  if [[ $rc -ne 0 ]]; then
    cat "$log" >&2
    return 1
  fi

  grep -Eq 'tot_recv_msgs=40|tot_recv_msgs=4[0-9]' "$log"
  grep -Fq 'Total lost packets 0' "$log"
}

expect_peer_denied() {
  local container="$1"
  local network="$2"
  local server_ip="$3"
  local peer_ip="$4"
  local family_flag="$5"
  local label="$6"
  local client_log="$ARTIFACT_DIR/deny-$label-client.log"
  local server_log="$ARTIFACT_DIR/deny-$label-server.log"
  local client="vesper-turn-policy-deny-$label-$suffix"
  local -a family_args=()
  [[ -n "$family_flag" ]] && family_args+=("$family_flag")
  transient_containers+=("$client")

  set +e
  timeout 20 docker run --rm --name "$client" --network "$network" --entrypoint turnutils_uclient "$TURN_IMAGE" \
    -u vesper -w "$password" -p 3478 "${family_args[@]}" -c -n 1 \
    -e "$peer_ip" -r 9999 "$server_ip" >"$client_log" 2>&1
  local rc=$?
  set -e
  docker rm -f "$client" >/dev/null 2>&1 || true

  if [[ $rc -eq 0 ]]; then
    echo "coturn unexpectedly permitted peer $peer_ip" >&2
    return 1
  fi

  for _ in $(seq 1 10); do
    docker logs "$container" >"$server_log" 2>&1
    if grep -F "A peer IP $peer_ip denied" "$server_log" >/dev/null; then
      grep -Fq 'error 403: Forbidden IP' "$server_log"
      return 0
    fi
    sleep 1
  done

  echo "coturn did not emit an explicit denial for $peer_ip" >&2
  return 1
}

echo "Testing TURN policy with $TURN_IMAGE"
docker pull "$TURN_IMAGE" >/dev/null

docker network create --subnet 11.201.0.0/24 "$v4_network" >/dev/null
docker run -d --name "$v4_server" --network "$v4_network" --ip 11.201.0.2 \
  -v "$CONFIG:/etc/coturn/turnserver.conf:ro" "$TURN_IMAGE" \
  -c /etc/coturn/turnserver.conf --lt-cred-mech --realm=turn-policy.invalid \
  --user="vesper:$password" --external-ip=11.201.0.2 \
  --listening-ip=11.201.0.2 --relay-ip=11.201.0.2 >/dev/null
wait_for_server "$v4_server"
assert_config_parsed "$v4_server"
run_positive_relay "$v4_network" 11.201.0.2 '' ipv4
expect_peer_denied "$v4_server" "$v4_network" 11.201.0.2 10.0.0.1 '' private-ipv4
expect_peer_denied "$v4_server" "$v4_network" 11.201.0.2 203.0.113.9 '' special-ipv4

# 2001:3::/32 is a globally reachable exception inside the otherwise denied
# 2001::/23 IETF assignments block, so this positive relay also proves that
# coturn applies the narrow static allowance before the broad static denial.
docker network create --ipv6 --subnet 11.202.0.0/24 \
  --subnet 2001:3:ffff:201::/64 "$v6_network" >/dev/null
docker run -d --name "$v6_server" --network "$v6_network" \
  --ip 11.202.0.2 --ip6 2001:3:ffff:201::2 \
  -v "$CONFIG:/etc/coturn/turnserver.conf:ro" "$TURN_IMAGE" \
  -c /etc/coturn/turnserver.conf --lt-cred-mech --realm=turn-policy.invalid \
  --user="vesper:$password" --external-ip=2001:3:ffff:201::2 \
  --listening-ip=2001:3:ffff:201::2 --relay-ip=2001:3:ffff:201::2 >/dev/null
wait_for_server "$v6_server"
run_positive_relay "$v6_network" 2001:3:ffff:201::2 -x ipv6-allowed-exception
expect_peer_denied "$v6_server" "$v6_network" 2001:3:ffff:201::2 fd00::1 -x ula-ipv6
expect_peer_denied "$v6_server" "$v6_network" 2001:3:ffff:201::2 64:ff9b::a00:1 -x nat64-private-ipv4
expect_peer_denied "$v6_server" "$v6_network" 2001:3:ffff:201::2 ::ffff:10.0.0.1 -x mapped-private-ipv4

echo "TURN policy passed: public IPv4/IPv6 relay works and private/special peers fail with 403"
echo "Evidence: $ARTIFACT_DIR"
