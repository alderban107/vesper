defmodule Vesper.Workers.DispatchMlsEvictionOutbox do
  @moduledoc """
  Hands durable membership and device removal obligations to the MLS eviction
  queue. A periodic job retries rows that were committed when Oban was down.
  """

  use Oban.Worker,
    queue: :crypto_evictions,
    max_attempts: 20,
    unique: [
      period: 30,
      fields: [:worker, :args],
      keys: [:outbox_id],
      states: [:available, :scheduled, :retryable]
    ]

  alias Vesper.Servers

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"outbox_id" => outbox_id}}) do
    case Servers.dispatch_mls_eviction_outbox(outbox_id) do
      :ok -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  def perform(%Oban.Job{}) do
    Servers.dispatch_pending_mls_eviction_outbox()
  end
end
