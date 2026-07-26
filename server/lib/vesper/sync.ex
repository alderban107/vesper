defmodule Vesper.Sync do
  import Ecto.Query

  alias Vesper.Chat.DmParticipant
  alias Vesper.Repo
  alias Vesper.ScopeSyncEvent
  alias Vesper.Servers.{Channel, Membership}
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
  Append a user-targeted change for one channel or DM scope.
  """
  def append_user_scope_event(user_id, event_type, scope_kind, scope_id, payload \\ %{})
      when is_binary(user_id) and is_binary(event_type) and is_binary(scope_kind) and
             is_binary(scope_id) do
    insert_user_events([
      %{
        user_id: user_id,
        event_type: event_type,
        scope_kind: scope_kind,
        scope_id: scope_id,
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
  Return one bounded urgent-event page and the only cursor through which the
  caller may advance. Non-urgent gaps are consumed only when no urgent event
  remains before the captured high-water mark.
  """
  def list_urgent_events_page(user_id, after_event_id, high_water, opts \\ [])
      when is_binary(user_id) and is_integer(after_event_id) do
    limit = Keyword.get(opts, :limit, 50)
    high_water = high_water || after_event_id

    rows =
      from(event in UserSyncEvent,
        where:
          event.user_id == ^user_id and
            event.id > ^after_event_id and
            event.id <= ^high_water and
            event.event_type == "urgent_message",
        order_by: [asc: event.id],
        limit: ^(limit + 1)
      )
      |> Repo.all()

    has_more = length(rows) > limit
    events = Enum.take(rows, limit)

    next_event_id =
      if has_more do
        List.last(events).id
      else
        high_water
      end

    %{events: events, next_event_id: next_event_id, has_more: has_more}
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
      |> reduce_changes()
    end
  end

  @doc """
  List scope changes since cursors. Queries the shared scope event log
  plus per-user events. Accepts separate scope and user cursors.
  """
  def list_scope_changes_since(user_id, after_scope_event_id)
      when is_binary(user_id) do
    list_scope_changes_with_cursors(user_id, after_scope_event_id, after_scope_event_id)
  end

  def list_scope_changes_with_cursors(user_id, scope_cursor, user_cursor)
      when is_binary(user_id) and is_integer(scope_cursor) and is_integer(user_cursor) do
    scope_events =
      from(event in ScopeSyncEvent,
        where: event.id > ^scope_cursor,
        order_by: [asc: event.id]
      )
      |> Repo.all()

    user_events = list_events_since(user_id, user_cursor)

    reduce_changes(scope_events ++ user_events)
  end

  @doc """
  Return one bounded, authorization-filtered account delta page. Each log has
  its own high-water mark and continuation cursor so a client cannot advance
  past events that were not represented in the response.
  """
  def list_scope_changes_page(
        user_id,
        scope_cursor,
        user_cursor,
        scope_high_water,
        user_high_water,
        opts \\ []
      )
      when is_binary(user_id) and is_integer(scope_cursor) and is_integer(user_cursor) do
    limit = Keyword.get(opts, :limit, 100)
    scope_high_water = scope_high_water || scope_cursor
    user_high_water = user_high_water || user_cursor

    scope_rows =
      relevant_scope_events_query(user_id, scope_cursor, scope_high_water, limit + 1)
      |> Repo.all()

    user_rows =
      from(event in UserSyncEvent,
        where:
          event.user_id == ^user_id and
            event.id > ^user_cursor and
            event.id <= ^user_high_water,
        order_by: [asc: event.id],
        limit: ^(limit + 1)
      )
      |> Repo.all()

    scope_has_more = length(scope_rows) > limit
    user_has_more = length(user_rows) > limit
    scope_events = Enum.take(scope_rows, limit)
    user_events = Enum.take(user_rows, limit)

    changes = reduce_changes(scope_events ++ user_events)

    Map.merge(changes, %{
      next_scope_event_id:
        next_page_cursor(scope_events, scope_has_more, scope_high_water, scope_cursor),
      next_user_event_id:
        next_page_cursor(user_events, user_has_more, user_high_water, user_cursor),
      has_more: scope_has_more or user_has_more
    })
  end

  defp relevant_scope_events_query(user_id, after_event_id, high_water, page_limit) do
    fields = [:id, :event_type, :scope_kind, :scope_id, :payload, :inserted_at]

    server_events =
      from(event in ScopeSyncEvent,
        join: membership in Membership,
        on:
          membership.user_id == ^user_id and
            membership.server_id == event.scope_id,
        where:
          event.scope_kind == "server" and
            event.id > ^after_event_id and
            event.id <= ^high_water,
        order_by: [asc: event.id],
        limit: ^page_limit,
        select: map(event, ^fields)
      )
      |> bounded_union_branch(fields)

    channel_events =
      from(event in ScopeSyncEvent,
        join: channel in Channel,
        on: channel.id == event.scope_id,
        join: membership in Membership,
        on:
          membership.user_id == ^user_id and
            membership.server_id == channel.server_id,
        where:
          event.scope_kind == "channel" and
            event.id > ^after_event_id and
            event.id <= ^high_water,
        order_by: [asc: event.id],
        limit: ^page_limit,
        select: map(event, ^fields)
      )
      |> bounded_union_branch(fields)

    dm_events =
      from(event in ScopeSyncEvent,
        join: participant in DmParticipant,
        on:
          participant.user_id == ^user_id and
            participant.conversation_id == event.scope_id,
        where:
          event.scope_kind == "dm" and
            event.id > ^after_event_id and
            event.id <= ^high_water,
        order_by: [asc: event.id],
        limit: ^page_limit,
        select: map(event, ^fields)
      )
      |> bounded_union_branch(fields)

    server_events
    |> union_all(^channel_events)
    |> union_all(^dm_events)
    |> subquery()
    |> then(fn events ->
      from(event in events, order_by: [asc: event.id], limit: ^page_limit)
    end)
  end

  defp bounded_union_branch(query, fields) do
    from(event in subquery(query), select: map(event, ^fields))
  end

  defp next_page_cursor(events, true, _high_water, current_cursor),
    do: (List.last(events) && List.last(events).id) || current_cursor

  defp next_page_cursor(_events, false, high_water, _current_cursor), do: high_water

  defp reduce_changes(events) do
    events
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
