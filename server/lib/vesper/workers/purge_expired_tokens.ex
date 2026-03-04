defmodule Vesper.Workers.PurgeExpiredTokens do
  @moduledoc """
  Oban worker that deletes user tokens older than 30 days.
  Runs daily via crontab.
  """
  use Oban.Worker, queue: :default, max_attempts: 3, unique: [period: 300]
  import Ecto.Query
  require Logger

  alias Vesper.Accounts.UserToken
  alias Vesper.Repo

  @impl Oban.Worker
  def perform(_job) do
    cutoff = DateTime.add(DateTime.utc_now(), -30 * 86_400, :second) |> DateTime.truncate(:second)

    {count, _} =
      from(t in UserToken, where: t.inserted_at < ^cutoff)
      |> Repo.delete_all()

    if count > 0, do: Logger.info("Purged #{count} expired user tokens")
    :ok
  end
end
