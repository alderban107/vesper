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
      states: [:available, :scheduled, :retryable]
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
    case Encryption.request_pending_crypto_eviction_batch(scope_kind, scope_id) do
      [] ->
        :ok

      evictions ->
        payloads =
          Enum.map(evictions, fn eviction ->
            %{
              id: eviction.id,
              target_user_id: eviction.target_user_id,
              target_device_id: eviction.target_device_id,
              reason: eviction.reason,
              attempt_count: eviction.attempt_count,
              membership_generation: eviction.membership_generation,
              fencing_token: eviction.fencing_token,
              requested_at: eviction.requested_at
            }
          end)

        first = hd(payloads)

        Endpoint.broadcast(
          scope_topic(scope_kind, scope_id),
          "mls_eviction_request",
          first
          |> Map.put(:scope_kind, scope_kind)
          |> Map.put(:scope_id, scope_id)
          |> Map.put(:group_id, hd(evictions).group_id)
          |> Map.put(:evictions, payloads)
        )

        if Encryption.has_active_crypto_evictions?(scope_kind, scope_id) do
          :ok =
            Encryption.enqueue_crypto_eviction_scope(scope_kind, scope_id,
              schedule_in: @request_retry_seconds
            )
        end

        Logger.debug("Requested MLS eviction batch for #{scope_kind}:#{scope_id}",
          scope_kind: scope_kind,
          scope_id: scope_id,
          eviction_count: length(evictions)
        )

        :ok
    end
  end

  defp scope_topic("channel", scope_id), do: "chat:channel:#{scope_id}"
  defp scope_topic("dm", scope_id), do: "dm:#{scope_id}"
  defp scope_topic("voice", scope_id), do: "voice:channel:#{scope_id}"
  defp scope_topic("voice_dm", scope_id), do: "voice:dm:#{scope_id}"
  defp scope_topic(scope_kind, scope_id), do: "#{scope_kind}:#{scope_id}"
end
