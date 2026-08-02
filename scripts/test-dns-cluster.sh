#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_IMAGE="${APP_IMAGE:-vesper-app-test}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d /tmp/vesper-dns-cluster.XXXXXX)}"
mkdir -p "$ARTIFACT_DIR"

POSTGRES_IMAGE="${POSTGRES_IMAGE:-$(
  awk '
    /^  db:$/ { in_db = 1; next }
    in_db && /^[[:space:]]+image:/ { print $2; exit }
  ' "$ROOT/docker-compose.yml"
)}"

if [[ -z "$POSTGRES_IMAGE" || "$POSTGRES_IMAGE" != *@sha256:* ]]; then
  echo "Could not resolve a digest-pinned PostgreSQL image from docker-compose.yml" >&2
  exit 1
fi

suffix="${GITHUB_RUN_ID:-$$}-${RANDOM}"
network="vesper-dns-cluster-$suffix"
db="vesper-dns-cluster-db-$suffix"
app1="vesper-dns-cluster-app1-$suffix"
app2="vesper-dns-cluster-app2-$suffix"
db_password="$(openssl rand -hex 32)"
secret="$(openssl rand -hex 64)"
metrics_token="$(openssl rand -hex 32)"
turn_password="$(openssl rand -hex 32)"
cookie="$(openssl rand -hex 32)"

cleanup() {
  docker rm -f "$app1" "$app2" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

common_env=(
  -e "DATABASE_URL=ecto://vesper:$db_password@11.203.0.10/vesper_cluster"
  -e "SECRET_KEY_BASE=$secret"
  -e "PHX_HOST=cluster.invalid"
  -e "CORS_ORIGIN=https://cluster.invalid"
  -e "METRICS_TOKEN=$metrics_token"
  -e "TURN_SERVER_URL=turn:turn.cluster.invalid:3478"
  -e "TURN_USERNAME=vesper"
  -e "TURN_PASSWORD=$turn_password"
  -e "REGISTRATION_MODE=closed"
  -e "RUN_MIGRATIONS_ON_START=false"
)

wait_for_postgres() {
  for _ in $(seq 1 30); do
    if docker exec "$db" pg_isready -U vesper -d vesper_cluster >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$db" >&2 2>&1 || true
  return 1
}

wait_for_health() {
  local container="$1"
  for _ in $(seq 1 60); do
    if docker exec "$container" curl -fsS http://localhost:4000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 2>&1 || true
  return 1
}

node_list() {
  local container="$1"
  local node="$2"
  docker exec -e "RELEASE_NODE=$node" -e RELEASE_DISTRIBUTION=name \
    -e "RELEASE_COOKIE=$cookie" "$container" \
    bin/vesper rpc 'IO.puts(Node.list() |> Enum.map(&Atom.to_string/1) |> Enum.sort() |> Enum.join(","))'
}

echo "Testing DNS A/AAAA clustering with $APP_IMAGE"
docker image inspect "$APP_IMAGE" >/dev/null
docker pull "$POSTGRES_IMAGE" >/dev/null

docker network create --subnet 11.203.0.0/24 "$network" >/dev/null
docker run -d --name "$db" --network "$network" --ip 11.203.0.10 \
  -e POSTGRES_USER=vesper -e "POSTGRES_PASSWORD=$db_password" \
  -e POSTGRES_DB=vesper_cluster "$POSTGRES_IMAGE" >/dev/null
wait_for_postgres

docker run --rm --network "$network" "${common_env[@]}" \
  -e RELEASE_DISTRIBUTION=none --entrypoint /bin/sh "$APP_IMAGE" \
  -c "bin/vesper eval 'Vesper.Release.migrate()'" >"$ARTIFACT_DIR/migration.log" 2>&1

docker run -d --name "$app1" --network "$network" --ip 11.203.0.21 \
  --network-alias vesper-apps "${common_env[@]}" \
  -e DNS_CLUSTER_QUERY=vesper-apps -e RELEASE_DISTRIBUTION=name \
  -e RELEASE_NODE=vesper@11.203.0.21 -e "RELEASE_COOKIE=$cookie" \
  "$APP_IMAGE" >/dev/null
docker run -d --name "$app2" --network "$network" --ip 11.203.0.22 \
  --network-alias vesper-apps "${common_env[@]}" \
  -e DNS_CLUSTER_QUERY=vesper-apps -e RELEASE_DISTRIBUTION=name \
  -e RELEASE_NODE=vesper@11.203.0.22 -e "RELEASE_COOKIE=$cookie" \
  "$APP_IMAGE" >/dev/null

wait_for_health "$app1"
wait_for_health "$app2"

docker logs "$app1" >"$ARTIFACT_DIR/app1.log" 2>&1
docker logs "$app2" >"$ARTIFACT_DIR/app2.log" 2>&1

normalized_query="$(docker exec -e RELEASE_NODE=vesper@11.203.0.21 \
  -e RELEASE_DISTRIBUTION=name -e "RELEASE_COOKIE=$cookie" "$app1" \
  bin/vesper rpc 'IO.puts(Application.fetch_env!(:vesper, :dns_cluster_query))' | tail -n 1)"
if [[ "$normalized_query" != "vesper-apps." ]]; then
  echo "DNS_CLUSTER_QUERY was not normalized to an absolute name: $normalized_query" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  list1="$(node_list "$app1" vesper@11.203.0.21 | tail -n 1)"
  list2="$(node_list "$app2" vesper@11.203.0.22 | tail -n 1)"
  if [[ ",$list1," == *",vesper@11.203.0.22,"* && ",$list2," == *",vesper@11.203.0.21,"* ]]; then
    printf 'normalized_query=%s\napp1_nodes=%s\napp2_nodes=%s\n' \
      "$normalized_query" "$list1" "$list2" | tee "$ARTIFACT_DIR/result.txt"
    echo "DNS cluster passed: both nodes discovered each other through an absolute A/AAAA query"
    echo "Evidence: $ARTIFACT_DIR"
    exit 0
  fi
  sleep 1
done

printf 'app1_nodes=%s\napp2_nodes=%s\n' "$list1" "$list2" >"$ARTIFACT_DIR/result.txt"
echo "Application nodes did not form a bidirectional cluster" >&2
exit 1
