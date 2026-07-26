# Account profile fixture exhausts PostgreSQL and rejects room kinds

## Reproduce

Run the account-sync profiler smoke fixture against the existing local PostgreSQL service. The profiler boots one Phoenix test stack and starts a second `mix run` process for direct fixture insertion. PostgreSQL reports `too_many_connections`, then `Repo.insert_all(Room, ...)` rejects the string value `"channel"` for the `Ecto.Enum` room kind.

## Isolate

`config/runtime.exs` overrides the ordinary test repository configuration whenever `VESPER_E2E=1`, setting `Vesper.Repo` to `VESPER_E2E_DB_POOL_SIZE` with a default of 64. Both the Phoenix stack and the fixture `mix run` process set `VESPER_E2E=1`, so changing `TEST_DB_POOL_SIZE` does not affect either runtime pool. The fixture intentionally uses schema-aware `insert_all` to dump UUIDs correctly; that also means enum fields must use schema values (`:channel` and `:dm`) rather than raw database strings.

## Hypothesize

1. **Primary: both profiler BEAM processes inherit the E2E runtime pool default of 64.** Falsification: setting `VESPER_E2E_DB_POOL_SIZE` to a bounded value for both processes still creates dozens of `db_conn_*` workers.
2. **The local PostgreSQL service has leaked profile stacks.** Falsification: process and `pg_stat_activity` inspection after failure show no surviving BEAM process or client connections.
3. **Schema-aware bulk insertion cannot seed rooms.** Falsification: atom enum values dump successfully while retaining UUID casting.

## Verify

The second run disproved the initial test-config theory: dozens of connection attempts remained despite `TEST_DB_POOL_SIZE=4`. Source inspection then identified the `VESPER_E2E` runtime override and its default of 64. Process and PostgreSQL inspection showed no orphaned stack. The independent `Ecto.ChangeError` explicitly identified `Vesper.Runtime.Room.kind` and the accepted enum values. The profiler must set `VESPER_E2E_DB_POOL_SIZE` for every process and use atom room kinds.
