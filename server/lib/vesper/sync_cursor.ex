defmodule Vesper.SyncCursor do
  @moduledoc false

  def encode(%{synced_at: %DateTime{} = datetime} = payload) do
    encoded =
      payload
      |> Map.put(:synced_at, DateTime.truncate(datetime, :second) |> DateTime.to_iso8601())
      |> Jason.encode!()

    Base.url_encode64(encoded, padding: false)
  end

  def encode(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
    |> Base.url_encode64(padding: false)
  end

  def decode(nil), do: nil

  def decode(value) when is_binary(value) do
    decoded =
      case Base.url_decode64(value, padding: false) do
        {:ok, token} -> token
        :error -> value
      end

    with {:ok, parsed} <- decode_json(decoded),
         {:ok, synced_at} <- decode_datetime(Map.get(parsed, "synced_at")) do
      %{
        synced_at: DateTime.add(synced_at, -1, :second),
        user_sync_event_id: decode_integer(Map.get(parsed, "user_sync_event_id"))
      }
    else
      _ ->
        case DateTime.from_iso8601(decoded) do
          {:ok, parsed, _offset} -> %{synced_at: DateTime.add(parsed, -1, :second), user_sync_event_id: nil}
          _ -> nil
        end
    end
  end

  def decode(_value), do: nil

  defp decode_json(value) do
    case Jason.decode(value) do
      {:ok, parsed} when is_map(parsed) -> {:ok, parsed}
      _ -> :error
    end
  end

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
