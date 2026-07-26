defmodule Vesper.Runtime do
  import Ecto.Query

  alias Vesper.Encryption
  alias Vesper.Sync
  alias Vesper.Chat.{DmConversation, Message}
  alias Vesper.Repo
  alias Vesper.Runtime.{Room, RoomEvent, RoomRelation}
  alias Vesper.Servers.Channel

  @room_cache :vesper_room_cache

  def init_room_cache do
    if :ets.info(@room_cache) == :undefined do
      :ets.new(@room_cache, [:set, :public, :named_table, read_concurrency: true])
    end

    :ok
  end

  def warm_room_cache do
    rooms = Repo.all(from(r in Room, select: r))

    for room <- rooms do
      case room.kind do
        :channel when is_binary(room.channel_id) ->
          :ets.insert(@room_cache, {{:channel, room.channel_id}, room})

        :dm when is_binary(room.conversation_id) ->
          :ets.insert(@room_cache, {{:dm, room.conversation_id}, room})

        _ ->
          :ok
      end
    end

    :ok
  rescue
    e in [DBConnection.ConnectionError, Postgrex.Error, RuntimeError] ->
      require Logger
      Logger.warning("Room cache warm skipped (DB not ready): #{Exception.message(e)}")
      :ok
  end

  def get_room(id), do: Repo.get(Room, id)

  def get_room_for_channel(channel_id) do
    Repo.get_by(Room, channel_id: channel_id)
  end

  def get_room_for_conversation(conversation_id) do
    Repo.get_by(Room, conversation_id: conversation_id)
  end

  @doc """
  Cached room lookup for the message send hot path.
  Only uses immutable fields (id, kind, server_id, channel_id, conversation_id).
  Do NOT use for reads that need fresh last_message_* or current_seq fields.
  """
  def get_room_for_message_send(channel_id: channel_id) do
    case lookup_room_cache(:channel, channel_id) do
      {:ok, room} -> room
      :miss -> cache_and_return(:channel, channel_id, Repo.get_by(Room, channel_id: channel_id))
    end
  end

  def get_room_for_message_send(conversation_id: conversation_id) do
    case lookup_room_cache(:dm, conversation_id) do
      {:ok, room} ->
        room

      :miss ->
        cache_and_return(
          :dm,
          conversation_id,
          Repo.get_by(Room, conversation_id: conversation_id)
        )
    end
  end

  defp lookup_room_cache(kind, scope_id) do
    if :ets.info(@room_cache) != :undefined do
      case :ets.lookup(@room_cache, {kind, scope_id}) do
        [{{^kind, ^scope_id}, room}] -> {:ok, room}
        [] -> :miss
      end
    else
      :miss
    end
  end

  defp cache_and_return(kind, scope_id, room) do
    if room && :ets.info(@room_cache) != :undefined do
      :ets.insert(@room_cache, {{kind, scope_id}, room})
    end

    room
  end

  def ensure_room_for_channel(%Channel{} = channel) do
    case get_room_for_channel(channel.id) do
      %Room{} = room ->
        {:ok, room}

      nil ->
        %Room{}
        |> Room.changeset(%{
          kind: :channel,
          server_id: channel.server_id,
          channel_id: channel.id,
          activity_at: channel.inserted_at
        })
        |> Repo.insert()
    end
  end

  def ensure_room_for_conversation(%DmConversation{} = conversation) do
    case get_room_for_conversation(conversation.id) do
      %Room{} = room ->
        {:ok, room}

      nil ->
        %Room{}
        |> Room.changeset(%{
          kind: :dm,
          conversation_id: conversation.id,
          activity_at: conversation.inserted_at
        })
        |> Repo.insert()
    end
  end

  @doc """
  Project a message into the room event stream.

  IMPORTANT: This function MUST be called inside a Repo.transaction.
  It does not wrap itself in a transaction — the caller (Chat.create_message)
  provides the outer transaction for all-or-nothing atomicity.
  """
  def project_message(%Message{} = message) do
    with {:ok, room} <- room_for_message(message),
         :ok <-
           Encryption.validate_application_scheme(
             room.id,
             message.encryption_scheme,
             message.mls_epoch,
             message.encryption_group_id
           ),
         {:ok, event} <- ensure_message_event(room, message),
         {:ok, _} <- maybe_create_thread_relation(event, message) do
      update_room_last_message(room.id, message.id, message.inserted_at, event.room_seq)
      append_user_sync_events(room, "message")
      {:ok, event}
    end
  end

  def append_scope_event(scope_kind, scope_id, sender_id, event_type, content)
      when is_map(content) do
    with {:ok, room} <- room_for_scope(scope_kind, scope_id) do
      Repo.transaction(fn ->
        room_seq = next_room_seq!(room.id)

        %RoomEvent{}
        |> RoomEvent.changeset(%{
          room_id: room.id,
          room_seq: room_seq,
          sender_id: sender_id,
          event_type: event_type,
          content: content
        })
        |> Repo.insert()
        |> case do
          {:ok, event} = result ->
            update_room_last_mutation(room.id, event.inserted_at, room_seq)
            append_user_sync_events(room, "mutation")
            result

          error ->
            Repo.rollback(error)
        end
      end)
      |> case do
        {:ok, {:ok, event}} -> {:ok, event}
        {:error, error} -> error
      end
    end
  end

  def list_rooms_for_channels(channel_ids) when is_list(channel_ids) do
    if channel_ids == [] do
      %{}
    else
      from(room in Room,
        where: room.channel_id in ^channel_ids,
        select: {room.channel_id, room}
      )
      |> Repo.all()
      |> Map.new()
    end
  end

  def list_rooms_for_conversations(conversation_ids) when is_list(conversation_ids) do
    if conversation_ids == [] do
      %{}
    else
      from(room in Room,
        where: room.conversation_id in ^conversation_ids,
        select: {room.conversation_id, room}
      )
      |> Repo.all()
      |> Map.new()
    end
  end

  def list_scope_events(%Room{} = room, since, opts) do
    limit = Keyword.get(opts, :limit, 200)

    if is_nil(room.last_mutation_at) or DateTime.compare(room.last_mutation_at, since) != :gt do
      []
    else
      from(e in RoomEvent,
        where:
          e.room_id == ^room.id and
            e.event_type != "vesper.message" and
            e.inserted_at > ^since,
        order_by: [asc: e.room_seq],
        limit: ^limit
      )
      |> Repo.all()
    end
  end

  def list_scope_events(scope_kind, scope_id, since, opts \\ []) do
    with {:ok, room} <- room_for_scope(scope_kind, scope_id) do
      list_scope_events(room, since, opts)
    else
      _ -> []
    end
  end

  def list_scope_events_after_seq(%Room{} = room, after_seq, opts)
      when is_integer(after_seq) do
    limit = Keyword.get(opts, :limit, 200)

    if is_nil(room.last_mutation_seq) or after_seq >= room.last_mutation_seq do
      []
    else
      from(e in RoomEvent,
        where:
          e.room_id == ^room.id and
            e.event_type != "vesper.message" and
            e.room_seq > ^after_seq,
        order_by: [asc: e.room_seq],
        limit: ^limit
      )
      |> Repo.all()
    end
  end

  def list_scope_events_after_seq(scope_kind, scope_id, after_seq, opts \\ [])
      when is_integer(after_seq) do
    with {:ok, room} <- room_for_scope(scope_kind, scope_id) do
      list_scope_events_after_seq(room, after_seq, opts)
    else
      _ -> []
    end
  end

  def refresh_room_last_message_for_scope("channel", scope_id) when is_binary(scope_id) do
    with %Room{} = room <- Repo.get_by(Room, channel_id: scope_id) do
      refresh_room_last_message(room.id, channel_id: scope_id)
    else
      _ -> :ok
    end
  end

  def refresh_room_last_message_for_scope("dm", scope_id) when is_binary(scope_id) do
    with %Room{} = room <- Repo.get_by(Room, conversation_id: scope_id) do
      refresh_room_last_message(room.id, conversation_id: scope_id)
    else
      _ -> :ok
    end
  end

  def refresh_room_last_message_for_scope(_scope_kind, _scope_id), do: :ok

  defp room_for_message(%Message{channel_id: channel_id}) when not is_nil(channel_id) do
    case get_room_for_message_send(channel_id: channel_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_message(%Message{conversation_id: conversation_id})
       when not is_nil(conversation_id) do
    case get_room_for_message_send(conversation_id: conversation_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_message(_message), do: {:error, :room_not_found}

  defp room_for_scope("channel", scope_id) do
    case get_room_for_channel(scope_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_scope("dm", scope_id) do
    case get_room_for_conversation(scope_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_scope(_scope_kind, _scope_id), do: {:error, :room_not_found}

  defp ensure_message_event(%Room{} = room, %Message{} = message) do
    case Repo.get_by(RoomEvent, message_id: message.id) do
      %RoomEvent{} = event ->
        {:ok, event}

      nil ->
        # Combine next_room_seq + event insert into a single round-trip
        now = DateTime.utc_now() |> DateTime.truncate(:second)
        event_id = Ecto.UUID.generate()
        content = message_content(message)
        algorithm = if(message.ciphertext, do: message.encryption_scheme, else: nil)

        sql = """
        WITH seq AS (
          UPDATE rooms SET current_seq = current_seq + 1, updated_at = $2
          WHERE id = $1 RETURNING current_seq
        )
        INSERT INTO room_events (id, room_id, room_seq, sender_id, message_id, event_type, content, ciphertext, encryption_algorithm, mls_epoch, inserted_at, updated_at)
        SELECT $3, $1, seq.current_seq, $4, $5, 'vesper.message', $6, $7, $8, $9, $2, $2
        FROM seq
        RETURNING id, room_seq
        """

        params = [
          Ecto.UUID.dump!(room.id),
          now,
          Ecto.UUID.dump!(event_id),
          Ecto.UUID.dump!(message.sender_id),
          Ecto.UUID.dump!(message.id),
          content,
          message.ciphertext,
          algorithm,
          message.mls_epoch
        ]

        case Repo.query(sql, params) do
          {:ok, %Postgrex.Result{rows: [[raw_id, room_seq]]}} ->
            {:ok,
             %RoomEvent{
               id: Ecto.UUID.cast!(raw_id),
               room_id: room.id,
               room_seq: room_seq,
               sender_id: message.sender_id,
               message_id: message.id,
               event_type: "vesper.message"
             }}

          {:ok, %Postgrex.Result{rows: []}} ->
            {:error, :room_not_found}

          {:error, error} ->
            {:error, error}
        end
    end
  end

  defp maybe_create_thread_relation(%RoomEvent{} = event, %Message{} = message) do
    thread_root_id =
      cond do
        is_binary(message.thread_root_message_id) ->
          message.thread_root_message_id

        is_binary(message.parent_message_id) and message.is_reply != true ->
          message.parent_message_id

        true ->
          nil
      end

    case thread_root_id && Repo.get_by(RoomEvent, message_id: thread_root_id) do
      nil ->
        {:ok, event}

      %RoomEvent{} = parent_event ->
        case Repo.get_by(RoomRelation,
               event_id: event.id,
               related_event_id: parent_event.id,
               relation_type: "vesper.thread"
             ) do
          %RoomRelation{} ->
            {:ok, event}

          nil ->
            %RoomRelation{}
            |> RoomRelation.changeset(%{
              room_id: event.room_id,
              event_id: event.id,
              related_event_id: parent_event.id,
              sender_id: message.sender_id,
              relation_type: "vesper.thread",
              content: %{}
            })
            |> Repo.insert()
            |> case do
              {:ok, _relation} -> {:ok, event}
              {:error, changeset} -> {:error, changeset}
            end
        end
    end
  end

  defp message_content(%Message{} = message) do
    %{}
    |> maybe_put("parent_message_id", message.parent_message_id)
    |> maybe_put("thread_root_message_id", message.thread_root_message_id)
    |> maybe_put("reply_to_message_id", message.reply_to_message_id)
    |> maybe_put("edited_at", message.edited_at)
    |> maybe_put("expires_at", message.expires_at)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp update_room_last_message(room_id, message_id, inserted_at, room_seq) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Race-free: GREATEST ensures the highest seq wins regardless of execution order.
    # CASE expressions update message_id/at only when this seq is actually the highest,
    # preventing a lower-seq concurrent message from overwriting a higher-seq one.
    Repo.query!(
      """
      UPDATE rooms SET
        last_message_id = CASE WHEN COALESCE(last_message_seq, 0) < $3 THEN $1 ELSE last_message_id END,
        last_message_at = CASE WHEN COALESCE(last_message_seq, 0) < $3 THEN $2 ELSE last_message_at END,
        activity_at = CASE WHEN COALESCE(last_message_seq, 0) < $3 THEN clock_timestamp() ELSE activity_at END,
        last_message_seq = GREATEST(COALESCE(last_message_seq, 0), $3),
        updated_at = $4
      WHERE id = $5
      """,
      [Ecto.UUID.dump!(message_id), inserted_at, room_seq, now, Ecto.UUID.dump!(room_id)]
    )

    :ok
  end

  defp update_room_last_mutation(room_id, inserted_at, room_seq) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.query!(
      """
      UPDATE rooms SET
        last_mutation_at = CASE WHEN COALESCE(last_mutation_seq, 0) < $2 THEN $1 ELSE last_mutation_at END,
        last_mutation_seq = GREATEST(COALESCE(last_mutation_seq, 0), $2),
        updated_at = $3
      WHERE id = $4
      """,
      [inserted_at, room_seq, now, Ecto.UUID.dump!(room_id)]
    )

    :ok
  end

  defp refresh_room_last_message(room_id, scope_filter) do
    latest_message =
      Message
      |> where(^scope_filter)
      |> order_by([message], desc: message.inserted_at, desc: message.id)
      |> limit(1)
      |> Repo.one()

    {message_id, inserted_at, message_seq} =
      case latest_message do
        %Message{} = message ->
          {message.id, message.inserted_at, latest_message_seq(room_id, message.id)}

        nil ->
          {nil, nil, nil}
      end

    Repo.query!(
      """
      UPDATE rooms SET
        last_message_id = $1,
        last_message_at = $2,
        last_message_seq = $3,
        activity_at = COALESCE(
          $2,
          (SELECT inserted_at FROM dm_conversations WHERE id = rooms.conversation_id),
          rooms.inserted_at
        ),
        updated_at = $4
      WHERE id = $5
      """,
      [
        if(message_id, do: Ecto.UUID.dump!(message_id), else: nil),
        inserted_at,
        message_seq,
        DateTime.utc_now() |> DateTime.truncate(:second),
        Ecto.UUID.dump!(room_id)
      ]
    )

    :ok
  end

  defp latest_message_seq(room_id, message_id) do
    from(event in RoomEvent,
      where: event.room_id == ^room_id and event.message_id == ^message_id,
      select: event.room_seq,
      limit: 1
    )
    |> Repo.one()
  end

  defp next_room_seq!(room_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case Repo.query(
           "UPDATE rooms SET current_seq = current_seq + 1, updated_at = $2 WHERE id = $1 RETURNING current_seq",
           [Ecto.UUID.dump!(room_id), now]
         ) do
      {:ok, %Postgrex.Result{rows: [[room_seq]]}} -> room_seq
      {:ok, _result} -> raise "could not allocate room sequence for #{room_id}"
      {:error, error} -> raise error
    end
  end

  defp append_user_sync_events(
         %Room{kind: :channel, server_id: server_id, channel_id: channel_id},
         event_type
       )
       when is_binary(server_id) and is_binary(channel_id) do
    # append_scope_events writes to shared ScopeSyncEvent log (O(1), no user_ids needed)
    Sync.append_scope_event(event_type, "channel", channel_id)
  end

  defp append_user_sync_events(
         %Room{kind: :dm, conversation_id: conversation_id},
         event_type
       )
       when is_binary(conversation_id) do
    Sync.append_scope_event(event_type, "dm", conversation_id)
  end

  defp append_user_sync_events(_room, _event_type), do: :ok
end
