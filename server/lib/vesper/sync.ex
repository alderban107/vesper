defmodule Vesper.Sync do
  import Ecto.Query

  alias Vesper.Repo
  alias Vesper.ScopeSyncEvent
  alias Vesper.UserSyncEvent

  @doc """
  Append a single shared scope event. O(1) regardless of member count.
  Replaces the old per-user fan-out for scope-level events.
  """
  def append_scope_event(event_type, scope_kind, scope_id, payload \\ %{})
      when is_binary(event_type) and is_binary(scope_kind) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert_all(ScopeSyncEvent, [
      %{
        event_type: event_type,
        scope_kind: scope_kind,
        scope_id: scope_id,
        payload: payload,
        inserted_at: now
      }
    ])

    :ok
  end

  @doc """
  Backward-compatible wrapper. Writes a single scope event instead of N user events.
  The user_ids parameter is accepted but ignored — scope membership is resolved at read time.
  """
  def append_scope_events(user_ids, event_type, scope_kind, scope_id, payload \\ %{})
      when is_list(user_ids) and is_binary(event_type) and is_binary(scope_kind) do
    append_scope_event(event_type, scope_kind, scope_id, payload)
  end

  @doc """
  Append a user-targeted event. Still per-user (for DM notifications, device events).
  """
  def append_user_event(user_id, event_type, payload \\ %{}) when is_binary(user_id) do
    insert_user_events([
      %{
        user_id: user_id,
        event_type: event_type,
        payload: payload
      }
    ])
  end

  @doc """
  Append urgent events. These remain per-user since they target specific recipients.
  """
  def append_urgent_events(events) when is_list(events) do
    insert_user_events(
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

  @doc """
  Latest user-targeted event ID for cursor tracking.
  """
  def latest_event_id_for_user(user_id) when is_binary(user_id) do
    from(event in UserSyncEvent,
      where: event.user_id == ^user_id,
      select: max(event.id)
    )
    |> Repo.one()
  end

  @doc """
  Latest scope event ID (global cursor).
  """
  def latest_scope_event_id do
    from(event in ScopeSyncEvent, select: max(event.id))
    |> Repo.one()
  end

  @doc """
  List user-targeted events since a cursor.
  """
  def list_events_since(user_id, after_event_id) when is_binary(user_id) do
    from(event in UserSyncEvent,
      where: event.user_id == ^user_id and event.id > ^after_event_id,
      order_by: [asc: event.id]
    )
    |> Repo.all()
  end

  @doc """
  List urgent events (per-user) since a cursor.
  """
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

  @doc """
  List scope changes for a user since a scope event cursor.
  Joins against the user's scope memberships (channel IDs, conversation IDs)
  to return only relevant events. O(scopes) query instead of O(events * users).
  """
  def list_scope_changes_since(user_id, after_scope_event_id, scope_ids)
      when is_binary(user_id) and is_list(scope_ids) do
    if scope_ids == [] do
      %{
        channel_ids: [],
        conversation_ids: [],
        server_ids: [],
        read_changes: []
      }
    else
      from(event in ScopeSyncEvent,
        where: event.id > ^after_scope_event_id and event.scope_id in ^scope_ids,
        order_by: [asc: event.id]
      )
      |> Repo.all()
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
            when event_type in [
                   "message",
                   "mutation",
                   "conversation_upsert",
                   "conversation_reset"
                 ] ->
              %{acc | channels: MapSet.put(acc.channels, scope_id)}

            {"dm", scope_id, event_type}
            when event_type in [
                   "message",
                   "mutation",
                   "conversation_upsert",
                   "conversation_reset"
                 ] ->
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
  end

  @doc """
  List scope changes since a cursor. Queries the shared scope event log.
  For callers that don't have the user's scope IDs, this returns ALL scope events
  after the cursor — callers must filter by relevant scope_ids.
  """
  def list_scope_changes_since(user_id, after_event_id) when is_binary(user_id) do
    # Query scope events (shared log) plus any per-user events
    scope_events =
      from(event in ScopeSyncEvent,
        where: event.id > ^after_event_id,
        order_by: [asc: event.id]
      )
      |> Repo.all()

    user_events = list_events_since(user_id, after_event_id)

    (scope_events ++ user_events)
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
          when event_type in [
                 "message",
                 "mutation",
                 "conversation_upsert",
                 "conversation_reset"
               ] ->
            %{acc | channels: MapSet.put(acc.channels, scope_id)}

          {"dm", scope_id, event_type}
          when event_type in [
                 "message",
                 "mutation",
                 "conversation_upsert",
                 "conversation_reset"
               ] ->
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

  defp insert_user_events([]), do: :ok

  defp insert_user_events(events) do
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
