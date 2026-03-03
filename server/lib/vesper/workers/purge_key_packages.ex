defmodule Vesper.Workers.PurgeKeyPackages do
  @moduledoc """
  Oban worker that deletes consumed key packages older than 24 hours.
  Runs daily via crontab.
  """
  use Oban.Worker, queue: :default, max_attempts: 3
  require Logger

  alias Vesper.Encryption

  @impl Oban.Worker
  def perform(_job) do
    {count, _} = Encryption.purge_consumed_key_packages(24)
    if count > 0, do: Logger.info("Purged #{count} consumed key packages")
    :ok
  end
end
