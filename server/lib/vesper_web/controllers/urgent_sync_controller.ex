defmodule VesperWeb.UrgentSyncController do
  use VesperWeb, :controller

  alias Vesper.Sync
  alias Vesper.SyncCursor

  @default_limit 50
  @max_limit 100

  def index(conn, params) do
    user = conn.assigns.current_user
    cursor = SyncCursor.decode(params["since"])
    cursor_retained = SyncCursor.retained?(cursor)
    cursor_expired = not is_nil(cursor) and not cursor_retained
    after_event_id = cursor_retained && cursor.user_sync_event_id
    limit = parse_limit(params["limit"])

    high_water =
      (cursor_retained && cursor.user_sync_high_water) ||
        Sync.latest_event_id_for_user(user.id) || 0

    page =
      if is_integer(after_event_id) do
        Sync.list_urgent_events_page(user.id, after_event_id, high_water, limit: limit)
      else
        %{events: [], next_event_id: high_water, has_more: false}
      end

    token_payload = %{
      synced_at: DateTime.utc_now(),
      user_sync_event_id: page.next_event_id
    }

    token =
      token_payload
      |> maybe_put_page_high_water(page.has_more, high_water)
      |> SyncCursor.encode()

    json(conn, %{
      token: token,
      cursor_expired: cursor_expired,
      has_more: page.has_more,
      events: Enum.map(page.events, &event_json/1)
    })
  end

  defp maybe_put_page_high_water(payload, true, high_water),
    do: Map.put(payload, :user_sync_high_water, high_water)

  defp maybe_put_page_high_water(payload, false, _high_water), do: payload

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
