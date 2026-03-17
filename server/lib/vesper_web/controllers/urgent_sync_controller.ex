defmodule VesperWeb.UrgentSyncController do
  use VesperWeb, :controller

  alias Vesper.Sync
  alias Vesper.SyncCursor

  @default_limit 50
  @max_limit 100

  def index(conn, params) do
    user = conn.assigns.current_user
    cursor = SyncCursor.decode(params["since"])
    after_event_id = cursor && cursor.user_sync_event_id
    limit = parse_limit(params["limit"])

    events =
      if is_integer(after_event_id) do
        Sync.list_urgent_events_since(user.id, after_event_id, limit: limit)
      else
        []
      end

    token =
      SyncCursor.encode(%{
        synced_at: DateTime.utc_now(),
        user_sync_event_id: Sync.latest_event_id_for_user(user.id)
      })

    json(conn, %{
      token: token,
      events: Enum.map(events, &event_json/1)
    })
  end

  defp parse_limit(limit) when is_integer(limit) and limit > 0, do: min(limit, @max_limit)

  defp parse_limit(limit) when is_binary(limit) do
    case Integer.parse(limit) do
      {value, _rest} when value > 0 -> min(value, @max_limit)
      _ -> @default_limit
    end
  end

  defp parse_limit(_), do: @default_limit

  defp event_json(event) do
    %{
      id: event.id,
      scope_kind: event.scope_kind,
      scope_id: event.scope_id,
      event_type: event.event_type,
      inserted_at: event.inserted_at,
      payload: event.payload
    }
  end
end
