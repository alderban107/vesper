defmodule Vesper.Workers.PurgeRecoveryMaterial do
  @moduledoc """
  Deletes expired same-user recovery packages and retired room-key epochs.
  """

  use Oban.Worker, queue: :default, max_attempts: 3, unique: [period: 300]

  alias Vesper.Encryption

  @impl Oban.Worker
  def perform(_job) do
    {:ok, _counts} = Encryption.purge_expired_recovery_material()
    :ok
  end
end
