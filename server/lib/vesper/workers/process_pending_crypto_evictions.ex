defmodule Vesper.Workers.ProcessPendingCryptoEvictions do
  @moduledoc """
  Reissues MLS eviction requests for one encrypted scope until every pending leaf
  has either been removed with a durable commit or explicitly marked applied.
  """

  use Oban.Worker,
    queue: :crypto_evictions,
    max_attempts: 20,
    unique: [
      period: 30,
      fields: [:worker, :args],
      keys: [:scope_kind, :scope_id],
      states: [:available, :scheduled, :executing, :retryable]
    ]

  require Logger

  alias Vesper.Encryption
  alias VesperWeb.Endpoint

  @request_retry_seconds 5

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"scope_kind" => scope_kind, "scope_id" => scope_id}}) do
    request_scope(scope_kind, scope_id)
  end

  def request_scope(scope_kind, scope_id) do
    case Encryption.request_next_pending_crypto_eviction(scope_kind, scope_id) do
      nil ->
        :ok

      eviction ->
        Endpoint.broadcast(scope_topic(scope_kind, scope_id), "mls_eviction_request", %{
          id: eviction.id,
          scope_kind: scope_kind,
          scope_id: scope_id,
          group_id: eviction.group_id,
          target_user_id: eviction.target_user_id,
          target_device_id: eviction.target_device_id,
          reason: eviction.reason,
          attempt_count: eviction.attempt_count,
          requested_at: eviction.requested_at
        })

        if Encryption.has_active_crypto_evictions?(scope_kind, scope_id) do
          :ok =
            Encryption.enqueue_crypto_eviction_scope(scope_kind, scope_id,
              schedule_in: @request_retry_seconds
            )
        end

        Logger.debug("Requested MLS eviction for #{scope_kind}:#{scope_id}",
          scope_kind: scope_kind,
          scope_id: scope_id,
          eviction_id: eviction.id,
          target_user_id: eviction.target_user_id,
          target_device_id: eviction.target_device_id
        )

        :ok
    end
  end

  defp scope_topic("channel", scope_id), do: "chat:channel:#{scope_id}"
  defp scope_topic("dm", scope_id), do: "dm:#{scope_id}"
  defp scope_topic(scope_kind, scope_id), do: "#{scope_kind}:#{scope_id}"
end
