defmodule Vesper.SyncCursor do
  @moduledoc """
  Encodes and decodes opaque sync cursors for client delta polling.

  On decode, the timestamp is shifted back by 1 second to guarantee inclusion
  of events that were inserted in the same second as the cursor. This avoids
  edge-case data loss when two events share an identical truncated-to-second
  timestamp.
  """

  @cursor_version 1

  def encode(%{synced_at: %DateTime{} = datetime} = payload) do
    [
      @cursor_version,
      datetime |> DateTime.truncate(:second) |> DateTime.to_unix(),
      Map.get(payload, :user_sync_event_id),
      Map.get(payload, :scope_sync_event_id),
      Map.get(payload, :user_sync_high_water),
      Map.get(payload, :scope_sync_high_water)
    ]
    |> encode_token()
  end

  def encode(%DateTime{} = datetime) do
    [@cursor_version, datetime |> DateTime.truncate(:second) |> DateTime.to_unix()]
    |> encode_token()
  end

  def retention_cutoff(now \\ DateTime.utc_now()) do
    retention_days = Application.fetch_env!(:vesper, :sync_event_retention_days)
    DateTime.add(now, -retention_days * 86_400, :second)
  end

  def retained?(cursor, now \\ DateTime.utc_now())

  def retained?(%{synced_at: %DateTime{} = synced_at}, now) do
    DateTime.compare(synced_at, retention_cutoff(now)) != :lt
  end

  def retained?(_cursor, _now), do: false

  def decode(nil), do: nil

  def decode(value) when is_binary(value) do
    decoded =
      case Base.url_decode64(value, padding: false) do
        {:ok, token} -> token
        :error -> value
      end

    case decode_json(decoded) do
      {:ok, parsed} ->
        decode_payload(parsed)

      :error ->
        case DateTime.from_iso8601(decoded) do
          {:ok, parsed, _offset} ->
            # Shift back 1s to catch events inserted in the same truncated second
            %{synced_at: DateTime.add(parsed, -1, :second), user_sync_event_id: nil}

          _ ->
            nil
        end
    end
  end

  def decode(_value), do: nil

  defp encode_token(payload) do
    payload
    |> Jason.encode!()
    |> Base.url_encode64(padding: false)
  end

  defp decode_json(value) do
    case Jason.decode(value) do
      {:ok, parsed} when is_map(parsed) or is_list(parsed) -> {:ok, parsed}
      _ -> :error
    end
  end

  defp decode_payload([
         @cursor_version,
         unix_seconds,
         user_sync_event_id,
         scope_sync_event_id,
         user_sync_high_water,
         scope_sync_high_water
       ]) do
    with {:ok, synced_at} <- decode_unix_datetime(unix_seconds) do
      %{
        synced_at: DateTime.add(synced_at, -1, :second),
        user_sync_event_id: decode_integer(user_sync_event_id),
        scope_sync_event_id: decode_integer(scope_sync_event_id),
        user_sync_high_water: decode_integer(user_sync_high_water),
        scope_sync_high_water: decode_integer(scope_sync_high_water)
      }
    else
      _ -> nil
    end
  end

  defp decode_payload([@cursor_version, unix_seconds]) do
    with {:ok, synced_at} <- decode_unix_datetime(unix_seconds) do
      %{synced_at: DateTime.add(synced_at, -1, :second), user_sync_event_id: nil}
    else
      _ -> nil
    end
  end

  defp decode_payload(parsed) when is_map(parsed) do
    with {:ok, synced_at} <- decode_datetime(Map.get(parsed, "synced_at")) do
      %{
        synced_at: DateTime.add(synced_at, -1, :second),
        user_sync_event_id: decode_integer(Map.get(parsed, "user_sync_event_id")),
        scope_sync_event_id: decode_integer(Map.get(parsed, "scope_sync_event_id")),
        user_sync_high_water: decode_integer(Map.get(parsed, "user_sync_high_water")),
        scope_sync_high_water: decode_integer(Map.get(parsed, "scope_sync_high_water"))
      }
    else
      _ -> nil
    end
  end

  defp decode_payload(_parsed), do: nil

  defp decode_unix_datetime(value) when is_integer(value), do: DateTime.from_unix(value)
  defp decode_unix_datetime(_value), do: :error

  defp decode_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> {:ok, datetime}
      _ -> :error
    end
  end

  defp decode_datetime(_value), do: :error

  defp decode_integer(value) when is_integer(value), do: value
  defp decode_integer(_value), do: nil
end
