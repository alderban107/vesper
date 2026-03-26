defmodule Vesper.Workers.PurgeSyncEvents do
  @moduledoc """
  Oban worker that deletes sync events older than the configured retention period.
  Runs daily via crontab. Prevents unbounded growth of scope_sync_events and user_sync_events tables.
  """
  use Oban.Worker, queue: :default, max_attempts: 3, unique: [period: 300]

  import Ecto.Query

  require Logger

  alias Vesper.Repo
  alias Vesper.ScopeSyncEvent
  alias Vesper.UserSyncEvent

  @retention_days 7

  @impl Oban.Worker
  def perform(_job) do
    cutoff = DateTime.utc_now() |> DateTime.add(-@retention_days * 86_400, :second)

    {scope_count, _} =
      from(e in ScopeSyncEvent, where: e.inserted_at < ^cutoff)
      |> Repo.delete_all()

    {user_count, _} =
      from(e in UserSyncEvent, where: e.inserted_at < ^cutoff)
      |> Repo.delete_all()

    total = scope_count + user_count

    if total > 0,
      do:
        Logger.info("Purged #{total} old sync events (#{scope_count} scope, #{user_count} user)")

    :ok
  end
end
