#!/usr/bin/env bash
set -euo pipefail

if [[ "${MIX_ENV:-test}" != "test" ]]; then
  echo "This destructive upgrade check may run only with MIX_ENV=test" >&2
  exit 1
fi

fixture_file="$(mktemp /tmp/vesper-upgrade-fixture.XXXXXX)"
cleanup() {
  rm -f "$fixture_file"
  MIX_ENV=test mix ecto.drop --quiet >/dev/null 2>&1 || true
  MIX_ENV=test mix ecto.create --quiet >/dev/null
  MIX_ENV=test mix ecto.migrate --quiet >/dev/null
}
trap cleanup EXIT

MIX_ENV=test mix ecto.drop --quiet >/dev/null 2>&1 || true
MIX_ENV=test mix ecto.create --quiet >/dev/null
MIX_ENV=test mix ecto.migrate --quiet >/dev/null

FIXTURE_FILE="$fixture_file" MIX_ENV=test mix run --no-start -e '
  Application.ensure_all_started(:vesper)
  owner = Vesper.Factory.insert_user(%{username: "upgrade_owner"})
  member = Vesper.Factory.insert_user(%{username: "upgrade_member"})
  {:ok, server} = Vesper.Servers.create_server(owner, %{name: "Upgrade fixture"})
  Vesper.Factory.insert_membership(member, server)
  File.write!(System.fetch_env!("FIXTURE_FILE"), Jason.encode!(%{server_id: server.id}))
' >/dev/null

MIX_ENV=test mix ecto.rollback --step 1 --quiet >/dev/null
MIX_ENV=test mix ecto.migrate --quiet >/dev/null

FIXTURE_FILE="$fixture_file" MIX_ENV=test mix run --no-start -e '
  Application.ensure_all_started(:vesper)
  import Ecto.Query
  %{"server_id" => server_id} = System.fetch_env!("FIXTURE_FILE") |> File.read!() |> Jason.decode!()
  room_count = Vesper.Repo.aggregate(from(r in Vesper.Runtime.Room, where: r.server_id == ^server_id), :count)
  authorization_count =
    Vesper.Repo.aggregate(
      from(a in Vesper.Encryption.RoomHistoryAuthorization,
        join: r in Vesper.Runtime.Room,
        on: r.id == a.room_id,
        where: r.server_id == ^server_id
      ),
      :count
    )
  expected = room_count * 2
  if room_count == 0 or authorization_count != expected do
    raise "history authorization backfill mismatch: rooms=#{room_count}, expected=#{expected}, actual=#{authorization_count}"
  end
  columns = Ecto.Adapters.SQL.query!(Vesper.Repo, "SELECT column_name FROM information_schema.columns WHERE table_name = '\''messages'\'' AND column_name IN ('\''history_revision'\'', '\''history_signing_public_key'\'')", []).rows
  if length(columns) != 2, do: raise("history message columns missing after upgrade")
  IO.puts("verified history upgrade: #{room_count} rooms, #{authorization_count} tenure authorizations")
'

trap - EXIT
cleanup
