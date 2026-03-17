defmodule Vesper.Sync do
  import Ecto.Query

  alias Vesper.Repo
  alias Vesper.UserSyncEvent

  def append_scope_events(user_ids, event_type, scope_kind, scope_id, payload \\ %{})
      when is_list(user_ids) and is_binary(event_type) and is_binary(scope_kind) do
    insert_events(
      Enum.map(Enum.uniq(user_ids), fn user_id ->
        %{
          user_id: user_id,
          event_type: event_type,
          scope_kind: scope_kind,
          scope_id: scope_id,
          payload: payload
        }
      end)
    )
  end

  def append_user_event(user_id, event_type, payload \\ %{}) when is_binary(user_id) do
    insert_events([
      %{
        user_id: user_id,
        event_type: event_type,
        payload: payload
      }
    ])
  end

  def append_urgent_events(events) when is_list(events) do
    insert_events(
      Enum.flat_map(events, fn
        %{user_id: user_id, scope_kind: scope_kind, scope_id: scope_id, payload: payload}
        when is_binary(user_id) and is_binary(scope_kind) and is_map(payload) ->
          [
            %{
              user_id: user_id,
              event_type: "urgent_message",
              scope_kind: scope_kind,
              scope_id: scope_id,
              payload: payload
            }
          ]

        _ ->
          []
      end)
    )
  end

  def latest_event_id_for_user(user_id) when is_binary(user_id) do
    from(event in UserSyncEvent,
      where: event.user_id == ^user_id,
      select: max(event.id)
    )
    |> Repo.one()
  end

  def list_events_since(user_id, after_event_id) when is_binary(user_id) do
    from(event in UserSyncEvent,
      where: event.user_id == ^user_id and event.id > ^after_event_id,
      order_by: [asc: event.id]
    )
    |> Repo.all()
  end

  def list_urgent_events_since(user_id, after_event_id, opts \\ [])
      when is_binary(user_id) and is_integer(after_event_id) do
    limit = Keyword.get(opts, :limit, 50)

    from(event in UserSyncEvent,
      where:
        event.user_id == ^user_id and
          event.id > ^after_event_id and
          event.event_type == "urgent_message",
      order_by: [asc: event.id],
      limit: ^limit
    )
    |> Repo.all()
  end

  def list_scope_changes_since(user_id, after_event_id) when is_binary(user_id) do
    list_events_since(user_id, after_event_id)
    |> Enum.reduce(
      %{
        channels: MapSet.new(),
        conversations: MapSet.new(),
        reads: MapSet.new(),
        servers: MapSet.new()
      },
      fn event, acc ->
        case {event.scope_kind, event.scope_id, event.event_type} do
          {"server", scope_id, "server"} ->
            %{acc | servers: MapSet.put(acc.servers, scope_id)}

          {"channel", scope_id, event_type}
          when event_type in ["message", "mutation", "conversation_upsert", "conversation_reset"] ->
            %{acc | channels: MapSet.put(acc.channels, scope_id)}

          {"dm", scope_id, event_type}
          when event_type in ["message", "mutation", "conversation_upsert", "conversation_reset"] ->
            %{acc | conversations: MapSet.put(acc.conversations, scope_id)}

          {"channel", scope_id, "read"} ->
            %{acc | reads: MapSet.put(acc.reads, {:channel, scope_id})}

          {"dm", scope_id, "read"} ->
            %{acc | reads: MapSet.put(acc.reads, {:dm, scope_id})}

          _ ->
            acc
        end
      end
    )
    |> then(fn changes ->
      %{
        channel_ids: MapSet.to_list(changes.channels),
        conversation_ids: MapSet.to_list(changes.conversations),
        server_ids: MapSet.to_list(changes.servers),
        read_changes: MapSet.to_list(changes.reads)
      }
    end)
  end

  defp insert_events([]), do: :ok

  defp insert_events(events) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert_all(
      UserSyncEvent,
      Enum.map(events, fn event ->
        Map.merge(event, %{inserted_at: now})
      end)
    )

    :ok
  end
end
