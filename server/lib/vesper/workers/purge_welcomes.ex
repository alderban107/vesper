defmodule Vesper.Workers.PurgeWelcomes do
  @moduledoc """
  Oban worker that deletes pending welcomes older than 24 hours.
  Runs daily via crontab.
  """
  use Oban.Worker, queue: :default, max_attempts: 3, unique: [period: 300]
  require Logger

  alias Vesper.Encryption

  @impl Oban.Worker
  def perform(_job) do
    {count, _} = Encryption.purge_old_welcomes(24)
    if count > 0, do: Logger.info("Purged #{count} old pending welcomes")
    :ok
  end
end
