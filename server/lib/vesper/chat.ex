defmodule Vesper.Chat do
  require Logger
  import Ecto.Query
  alias Vesper.Repo

  alias Vesper.Chat.{
    Message,
    Attachment,
    DmConversation,
    DmParticipant,
    Reaction,
    ChannelReadPosition,
    DmReadPosition,
    PinnedMessage
  }

  alias Vesper.Runtime
  alias Vesper.Runtime.{Room, RoomEvent}
  alias Vesper.Sync

  # --- DM Conversations ---

  @doc """
  Create a DM conversation between participants.
  For direct (1:1) DMs, returns existing conversation if one already exists.
  """
  def create_conversation(creator_id, participant_ids, opts \\ []) do
    all_user_ids = Enum.uniq([creator_id | participant_ids])
    type = if length(all_user_ids) == 2, do: "direct", else: "group"
    name = Keyword.get(opts, :name)

    # For direct DMs, check if conversation already exists between these two users
    if type == "direct" do
      case find_direct_conversation(
             creator_id,
             List.first(participant_ids -- [creator_id]) || creator_id
           ) do
        %DmConversation{} = existing ->
          {:ok, Repo.preload(existing, participants: :user)}

        nil ->
          do_create_conversation(type, name, all_user_ids)
      end
    else
      do_create_conversation(type, name, all_user_ids)
    end
  end

  defp do_create_conversation(type, name, user_ids) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      conversation =
        %DmConversation{}
        |> DmConversation.changeset(%{type: type, name: name})
        |> Repo.insert!()

      case Runtime.ensure_room_for_conversation(conversation) do
        {:ok, _room} -> :ok
        {:error, changeset} -> Repo.rollback(changeset)
      end

      for user_id <- user_ids do
        %DmParticipant{}
        |> DmParticipant.changeset(%{conversation_id: conversation.id, user_id: user_id})
        |> Ecto.Changeset.put_change(:joined_at, now)
        |> Repo.insert!()
      end

      Repo.preload(conversation, participants: :user)
    end)
  end

  defp find_direct_conversation(user_a_id, user_b_id) do
    # Find a "direct" conversation where both users are participants
    from(c in DmConversation,
      where: c.type == "direct",
      join: p1 in DmParticipant,
      on: p1.conversation_id == c.id and p1.user_id == ^user_a_id,
      join: p2 in DmParticipant,
      on: p2.conversation_id == c.id and p2.user_id == ^user_b_id
    )
    |> Repo.one()
  end

  @doc """
  List all conversations a user participates in, with participants and last message.
  """
  def list_conversations(user_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)

    # Custom preload: join participants + users in a single query
    participants_with_users =
      from(p in DmParticipant,
        join: u in assoc(p, :user),
        preload: [user: u]
      )

    conversations =
      from(c in DmConversation,
        join: p in DmParticipant,
        on: p.conversation_id == c.id,
        where: p.user_id == ^user_id,
        preload: [participants: ^participants_with_users],
        order_by: [desc: c.inserted_at],
        limit: ^limit
      )
      |> Repo.all()

    conversations_with_last_message(conversations)
  end

  def list_user_conversation_ids(user_id) do
    from(p in DmParticipant,
      where: p.user_id == ^user_id,
      select: p.conversation_id
    )
    |> Repo.all()
  end

  def list_accessible_conversation_ids(user_id, conversation_ids)
      when is_list(conversation_ids) do
    if conversation_ids == [] do
      MapSet.new()
    else
      from(p in DmParticipant,
        where: p.user_id == ^user_id and p.conversation_id in ^conversation_ids,
        select: p.conversation_id
      )
      |> Repo.all()
      |> MapSet.new()
    end
  end

  @doc """
  List conversations whose structure or latest activity changed after the given time.
  """
  def list_conversations_since(user_id, since) do
    inserted_ids =
      from(c in DmConversation,
        join: p in DmParticipant,
        on: p.conversation_id == c.id,
        where: p.user_id == ^user_id and c.inserted_at > ^since,
        select: c.id
      )
      |> Repo.all()

    active_ids =
      from(room in Room,
        join: p in DmParticipant,
        on: p.conversation_id == room.conversation_id,
        where:
          room.kind == :dm and
            p.user_id == ^user_id and
            room.last_message_at > ^since,
        select: room.conversation_id,
        distinct: true
      )
      |> Repo.all()

    conversation_ids =
      inserted_ids
      |> Kernel.++(active_ids)
      |> Enum.uniq()

    conversations =
      if conversation_ids == [] do
        []
      else
        from(c in DmConversation,
          where: c.id in ^conversation_ids,
          preload: [participants: :user]
        )
        |> Repo.all()
      end

    conversations_with_last_message(conversations)
  end

  def list_conversations_by_ids(user_id, conversation_ids) when is_list(conversation_ids) do
    conversations =
      if conversation_ids == [] do
        []
      else
        from(c in DmConversation,
          join: p in DmParticipant,
          on: p.conversation_id == c.id,
          where: p.user_id == ^user_id and c.id in ^conversation_ids,
          preload: [participants: :user]
        )
        |> Repo.all()
      end

    conversations_with_last_message(conversations)
  end

  @doc """
  Get a conversation by ID with participants preloaded.
  """
  def get_conversation(id) do
    DmConversation
    |> Repo.get(id)
    |> case do
      nil -> nil
      conv -> Repo.preload(conv, participants: :user)
    end
  end

  @doc """
  Return all participant user IDs for a conversation.
  """
  def list_participant_ids(conversation_id) do
    from(p in DmParticipant,
      where: p.conversation_id == ^conversation_id,
      select: p.user_id
    )
    |> Repo.all()
  end

  @doc """
  Check if a user is a participant in a conversation.
  """
  def user_is_participant?(user_id, conversation_id) do
    from(p in DmParticipant,
      where: p.user_id == ^user_id and p.conversation_id == ^conversation_id
    )
    |> Repo.exists?()
  end

  defp conversations_with_last_message(conversations) do
    conv_ids = Enum.map(conversations, & &1.id)

    last_messages =
      if conv_ids != [] do
        from(m in Message,
          join: sender in assoc(m, :sender),
          where: m.conversation_id in ^conv_ids,
          distinct: m.conversation_id,
          order_by: [m.conversation_id, desc: m.inserted_at],
          preload: [sender: sender]
        )
        |> Repo.all()
        |> Map.new(&{&1.conversation_id, &1})
      else
        %{}
      end

    Enum.map(conversations, fn conv ->
      %{conversation: conv, last_message: Map.get(last_messages, conv.id)}
    end)
  end

  # --- Attachments ---

  def link_attachments_to_message([], _message_id), do: :ok

  def link_attachments_to_message(attachment_ids, message_id) when is_list(attachment_ids) do
    from(a in Attachment,
      where: a.id in ^attachment_ids and is_nil(a.message_id)
    )
    |> Repo.update_all(set: [message_id: message_id])

    :ok
  end

  # --- Messages ---

  def get_message(id) do
    from(m in Message,
      left_join: event in RoomEvent,
      on: event.message_id == m.id,
      where: m.id == ^id,
      select_merge: %{room_seq: event.room_seq}
    )
    |> Repo.one()
  end

  def get_message_with_details(id) do
    from(m in Message,
      left_join: event in RoomEvent,
      on: event.message_id == m.id,
      where: m.id == ^id,
      select_merge: %{room_seq: event.room_seq}
    )
    |> Repo.one()
    |> case do
      nil -> nil
      message -> Repo.preload(message, [:sender, :attachments, :reactions])
    end
  end

  def get_messages_with_details(ids) when is_list(ids) do
    unique_ids =
      ids
      |> Enum.filter(&(is_binary(&1) and &1 != ""))
      |> Enum.uniq()

    if unique_ids == [] do
      []
    else
      messages_by_id =
        from(m in Message,
          left_join: event in RoomEvent,
          on: event.message_id == m.id,
          where: m.id in ^unique_ids,
          select_merge: %{room_seq: event.room_seq},
          preload: [:sender, :attachments, :reactions]
        )
        |> Repo.all()
        |> Map.new(&{&1.id, &1})

      Enum.flat_map(unique_ids, fn id ->
        case Map.get(messages_by_id, id) do
          nil -> []
          message -> [message]
        end
      end)
    end
  end

  def update_message(%Message{} = message, attrs) do
    message
    |> Message.encrypted_changeset(attrs)
    |> Repo.update()
  end

  def delete_message(%Message{} = message) do
    # Collect attachment storage keys before deletion — the cascade will
    # destroy attachment rows, so we need the keys up front.
    storage_keys =
      from(a in Attachment,
        where: a.message_id == ^message.id,
        select: a.storage_key
      )
      |> Repo.all()

    deleted_scope =
      cond do
        is_binary(message.channel_id) -> {"channel", message.channel_id}
        is_binary(message.conversation_id) -> {"dm", message.conversation_id}
        true -> nil
      end

    case Repo.delete(message) do
      {:ok, _} = result ->
        case deleted_scope do
          {scope_kind, scope_id} ->
            Runtime.refresh_room_last_message_for_scope(scope_kind, scope_id)

          nil ->
            :ok
        end

        # Remove blobs that have zero remaining attachment references.
        # Storage keys are content-addressed (SHA256), so the same blob
        # may be referenced by attachments on other messages.
        for key <- Enum.uniq(storage_keys) do
          remaining =
            from(a in Attachment, where: a.storage_key == ^key)
            |> Repo.aggregate(:count, :id)

          if remaining == 0 do
            Vesper.Chat.FileStorage.delete(key)
          end
        end

        result

      error ->
        error
    end
  end

  @doc """
  Create and project a message atomically. If any step fails, the entire
  operation rolls back — no orphaned messages in the DB.

  Supports idempotent retries via `client_nonce`. If a message with the same
  (scope, sender, nonce) already exists, returns the existing message without
  re-broadcasting.

  Options:
  - `:preload` — associations to preload (default: `[:sender, :attachments]`, use `[]` to skip)
  """
  def create_message(attrs, opts \\ []) do
    attrs = maybe_set_expires_at(attrs)
    preload = Keyword.get(opts, :preload, [:sender, :attachments])
    changeset = Message.encrypted_changeset(%Message{}, attrs)

    Repo.transaction(fn ->
      case insert_or_fetch_existing(changeset, attrs) do
        {:new, message} ->
          case Runtime.project_message(message) do
            {:ok, event} ->
              message = %{message | room_seq: event.room_seq}
              maybe_preload_message(message, preload)

            {:error, reason} ->
              Repo.rollback({:projection_failed, reason})
          end

        {:existing, message} ->
          # Idempotent retry — message already created and projected
          maybe_preload_message(message, preload)
      end
    end)
  end

  defp insert_or_fetch_existing(changeset, attrs) do
    client_nonce = attrs[:client_nonce] || attrs["client_nonce"]

    if is_binary(client_nonce) and client_nonce != "" do
      # Idempotent path: use ON CONFLICT with nonce index
      conflict_target = nonce_conflict_target(attrs)

      case Repo.insert(changeset,
             on_conflict: :nothing,
             conflict_target: {:unsafe_fragment, conflict_target}
           ) do
        {:ok, %{id: nil}} ->
          # Conflict — fetch the existing message
          existing = fetch_by_nonce(attrs)

          if existing do
            # Load room_seq from the existing room event
            event = Repo.get_by(Vesper.Runtime.RoomEvent, message_id: existing.id)
            room_seq = if event, do: event.room_seq, else: nil
            {:existing, %{existing | room_seq: room_seq}}
          else
            raise "nonce conflict but existing message not found"
          end

        {:ok, message} ->
          {:new, message}

        {:error, changeset} ->
          Repo.rollback(changeset)
      end
    else
      # No nonce — standard insert (no idempotency)
      case Repo.insert(changeset) do
        {:ok, message} -> {:new, message}
        {:error, changeset} -> Repo.rollback(changeset)
      end
    end
  end

  defp nonce_conflict_target(attrs) do
    channel_id = attrs[:channel_id] || attrs["channel_id"]

    if channel_id do
      "(channel_id, sender_id, client_nonce) WHERE client_nonce IS NOT NULL AND channel_id IS NOT NULL"
    else
      "(conversation_id, sender_id, client_nonce) WHERE client_nonce IS NOT NULL AND conversation_id IS NOT NULL"
    end
  end

  defp fetch_by_nonce(attrs) do
    nonce = attrs[:client_nonce] || attrs["client_nonce"]
    sender_id = attrs[:sender_id] || attrs["sender_id"]
    channel_id = attrs[:channel_id] || attrs["channel_id"]
    conversation_id = attrs[:conversation_id] || attrs["conversation_id"]

    query =
      from(m in Message,
        where: m.sender_id == ^sender_id and m.client_nonce == ^nonce,
        limit: 1
      )

    query =
      if channel_id do
        from(m in query, where: m.channel_id == ^channel_id)
      else
        from(m in query, where: m.conversation_id == ^conversation_id)
      end

    Repo.one(query)
  end

  def update_conversation_ttl(conversation_id, ttl) do
    case Repo.get(DmConversation, conversation_id) do
      nil ->
        {:error, :not_found}

      conv ->
        conv
        |> DmConversation.changeset(%{disappearing_ttl: ttl})
        |> Repo.update()
    end
  end

  def delete_expired_messages do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Collect storage keys from attachments of expiring messages before deleting
    expiring_ids =
      from(m in Message,
        where: not is_nil(m.expires_at) and m.expires_at < ^now,
        select: m.id
      )
      |> Repo.all()

    storage_keys =
      if expiring_ids != [] do
        from(a in Attachment,
          where: a.message_id in ^expiring_ids,
          select: a.storage_key
        )
        |> Repo.all()
      else
        []
      end

    {count, _} =
      from(m in Message,
        where: not is_nil(m.expires_at) and m.expires_at < ^now
      )
      |> Repo.delete_all()

    # Clean orphaned blobs (no other attachment references the same storage_key)
    for key <- Enum.uniq(storage_keys) do
      remaining =
        from(a in Attachment, where: a.storage_key == ^key)
        |> Repo.aggregate(:count, :id)

      if remaining == 0 do
        Vesper.Chat.FileStorage.delete(key)
      end
    end

    {count, nil}
  end

  def list_channel_messages(channel_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    before = parse_message_cursor(Keyword.get(opts, :before))
    after_cursor = parse_message_cursor(Keyword.get(opts, :after))
    preload = message_preload(opts)

    cond do
      limit == 1 and is_nil(before) and is_nil(after_cursor) ->
        case get_latest_channel_message(channel_id, opts) do
          nil -> []
          message -> [message]
        end

      true ->
        non_sender = non_sender_preloads(preload)

        messages =
          from(m in Message,
            left_join: event in RoomEvent,
            on: event.message_id == m.id,
            join: sender in assoc(m, :sender),
            where: m.channel_id == ^channel_id,
            order_by: [desc: m.inserted_at, desc: m.id],
            limit: ^limit,
            select_merge: %{room_seq: event.room_seq},
            preload: [sender: sender]
          )
          |> apply_before_cursor(before)
          |> apply_after_cursor(after_cursor)
          |> Repo.all()

        if non_sender == [] do
          messages
        else
          Repo.preload(messages, non_sender)
        end
    end
  end

  def list_conversation_messages(conversation_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    before = parse_message_cursor(Keyword.get(opts, :before))
    after_cursor = parse_message_cursor(Keyword.get(opts, :after))
    preload = message_preload(opts)

    cond do
      limit == 1 and is_nil(before) and is_nil(after_cursor) ->
        case get_latest_conversation_message(conversation_id, opts) do
          nil -> []
          message -> [message]
        end

      true ->
        non_sender = non_sender_preloads(preload)

        messages =
          from(m in Message,
            left_join: event in RoomEvent,
            on: event.message_id == m.id,
            join: sender in assoc(m, :sender),
            where: m.conversation_id == ^conversation_id,
            order_by: [desc: m.inserted_at, desc: m.id],
            limit: ^limit,
            select_merge: %{room_seq: event.room_seq},
            preload: [sender: sender]
          )
          |> apply_before_cursor(before)
          |> apply_after_cursor(after_cursor)
          |> Repo.all()

        if non_sender == [] do
          messages
        else
          Repo.preload(messages, non_sender)
        end
    end
  end

  def get_latest_channel_message(channel_id, opts \\ []) do
    preload = message_preload(opts)

    from(room in Room,
      where: room.channel_id == ^channel_id and not is_nil(room.last_message_id),
      join: m in Message,
      on: m.id == room.last_message_id,
      limit: 1,
      select: %{m | room_seq: room.last_message_seq}
    )
    |> Repo.one()
    |> maybe_preload_message(preload)
  end

  def get_latest_channel_messages(channel_ids) when is_list(channel_ids) do
    if channel_ids == [] do
      %{}
    else
      from(room in Room,
        where: room.channel_id in ^channel_ids and not is_nil(room.last_message_id),
        join: m in Message,
        on: m.id == room.last_message_id,
        select: {room.channel_id, %{m | room_seq: room.last_message_seq}}
      )
      |> Repo.all()
      |> then(fn pairs ->
        messages =
          pairs
          |> Enum.map(&elem(&1, 1))
          |> Repo.preload(:sender)
          |> Map.new(&{&1.id, &1})

        Map.new(pairs, fn {channel_id, message} ->
          {channel_id, Map.fetch!(messages, message.id)}
        end)
      end)
    end
  end

  def get_latest_conversation_message(conversation_id, opts \\ []) do
    preload = message_preload(opts)

    from(room in Room,
      where: room.conversation_id == ^conversation_id and not is_nil(room.last_message_id),
      join: m in Message,
      on: m.id == room.last_message_id,
      limit: 1,
      select: %{m | room_seq: room.last_message_seq}
    )
    |> Repo.one()
    |> maybe_preload_message(preload)
  end

  def get_latest_conversation_messages(conversation_ids) when is_list(conversation_ids) do
    if conversation_ids == [] do
      %{}
    else
      from(room in Room,
        where: room.conversation_id in ^conversation_ids and not is_nil(room.last_message_id),
        join: m in Message,
        on: m.id == room.last_message_id,
        select: {room.conversation_id, %{m | room_seq: room.last_message_seq}}
      )
      |> Repo.all()
      |> then(fn pairs ->
        messages =
          pairs
          |> Enum.map(&elem(&1, 1))
          |> Repo.preload(:sender)
          |> Map.new(&{&1.id, &1})

        Map.new(pairs, fn {conversation_id, message} ->
          {conversation_id, Map.fetch!(messages, message.id)}
        end)
      end)
    end
  end

  # --- Threads ---

  def list_thread_messages(parent_message_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)

    from(m in Message,
      left_join: event in RoomEvent,
      on: event.message_id == m.id,
      where: m.parent_message_id == ^parent_message_id,
      order_by: [asc: m.inserted_at, asc: m.id],
      limit: ^limit,
      select_merge: %{room_seq: event.room_seq},
      preload: [:sender, :attachments, :reactions]
    )
    |> Repo.all()
  end

  def list_channel_messages_after_seq(channel_id, after_seq, opts \\ [])
      when is_integer(after_seq) do
    limit = Keyword.get(opts, :limit, 50)
    preload = message_preload(opts)
    room_id = Keyword.get(opts, :room_id)

    if is_binary(room_id) do
      from(event in RoomEvent,
        join: m in Message,
        on: m.id == event.message_id,
        where:
          event.room_id == ^room_id and
            m.channel_id == ^channel_id and
            event.room_seq > ^after_seq,
        order_by: [asc: event.room_seq],
        limit: ^limit,
        select: {m, event.room_seq}
      )
      |> Repo.all()
      |> preload_messages_with_room_seq(preload)
    else
      from(m in Message,
        join: event in RoomEvent,
        on: event.message_id == m.id,
        where: m.channel_id == ^channel_id and event.room_seq > ^after_seq,
        order_by: [asc: event.room_seq],
        limit: ^limit,
        select_merge: %{room_seq: event.room_seq},
        preload: ^preload
      )
      |> Repo.all()
    end
  end

  def list_conversation_messages_after_seq(conversation_id, after_seq, opts \\ [])
      when is_integer(after_seq) do
    limit = Keyword.get(opts, :limit, 50)
    preload = message_preload(opts)
    room_id = Keyword.get(opts, :room_id)

    if is_binary(room_id) do
      from(event in RoomEvent,
        join: m in Message,
        on: m.id == event.message_id,
        where:
          event.room_id == ^room_id and
            m.conversation_id == ^conversation_id and
            event.room_seq > ^after_seq,
        order_by: [asc: event.room_seq],
        limit: ^limit,
        select: {m, event.room_seq}
      )
      |> Repo.all()
      |> preload_messages_with_room_seq(preload)
    else
      from(m in Message,
        join: event in RoomEvent,
        on: event.message_id == m.id,
        where: m.conversation_id == ^conversation_id and event.room_seq > ^after_seq,
        order_by: [asc: event.room_seq],
        limit: ^limit,
        select_merge: %{room_seq: event.room_seq},
        preload: ^preload
      )
      |> Repo.all()
    end
  end

  defp message_preload(opts) do
    if Keyword.get(opts, :lean, false) do
      [:sender]
    else
      [:sender, :attachments, :reactions]
    end
  end

  defp non_sender_preloads(preload) do
    Enum.reject(preload, &(&1 == :sender))
  end

  defp maybe_preload_message(nil, _preload), do: nil
  defp maybe_preload_message(message, []), do: message
  defp maybe_preload_message(message, preload), do: Repo.preload(message, preload)

  defp preload_messages_with_room_seq(message_pairs, preload) do
    message_pairs
    |> Enum.map(&elem(&1, 0))
    |> Repo.preload(preload)
    |> Map.new(&{&1.id, &1})
    |> then(fn messages_by_id ->
      Enum.map(message_pairs, fn {message, room_seq} ->
        messages_by_id
        |> Map.fetch!(message.id)
        |> Map.put(:room_seq, room_seq)
      end)
    end)
  end

  defp parse_message_cursor(nil), do: nil

  defp parse_message_cursor(value) when is_binary(value) do
    case String.split(value, "|", parts: 2) do
      [timestamp, id] ->
        with {:ok, inserted_at, _offset} <- DateTime.from_iso8601(timestamp),
             true <- id != "" do
          %{inserted_at: inserted_at, id: id}
        else
          _ -> parse_timestamp_cursor(value)
        end

      _ ->
        parse_timestamp_cursor(value)
    end
  end

  defp parse_message_cursor(_value), do: nil

  defp parse_timestamp_cursor(value) do
    case DateTime.from_iso8601(value) do
      {:ok, inserted_at, _offset} -> %{inserted_at: inserted_at, id: nil}
      _ -> nil
    end
  end

  defp apply_before_cursor(query, nil), do: query

  defp apply_before_cursor(query, %{inserted_at: inserted_at, id: nil}) do
    from(m in query, where: m.inserted_at < ^inserted_at)
  end

  defp apply_before_cursor(query, %{inserted_at: inserted_at, id: id}) do
    from(m in query,
      where: m.inserted_at < ^inserted_at or (m.inserted_at == ^inserted_at and m.id < ^id)
    )
  end

  defp apply_after_cursor(query, nil), do: query

  defp apply_after_cursor(query, %{inserted_at: inserted_at, id: nil}) do
    from(m in query, where: m.inserted_at > ^inserted_at)
  end

  defp apply_after_cursor(query, %{inserted_at: inserted_at, id: id}) do
    from(m in query,
      where: m.inserted_at > ^inserted_at or (m.inserted_at == ^inserted_at and m.id > ^id)
    )
  end

  def count_thread_replies(message_id) do
    from(m in Message, where: m.parent_message_id == ^message_id)
    |> Repo.aggregate(:count, :id)
  end

  # --- Reactions ---

  def add_reaction(attrs) do
    %Reaction{}
    |> Reaction.changeset(attrs)
    |> Repo.insert()
  end

  def remove_reaction(message_id, sender_id, emoji) do
    case Repo.get_by(Reaction, message_id: message_id, sender_id: sender_id, emoji: emoji) do
      nil -> {:error, :not_found}
      reaction -> Repo.delete(reaction)
    end
  end

  @doc """
  Remove an encrypted reaction. Since the server cannot match on emoji content
  (it's encrypted), we remove the most recent reaction from this sender on this
  message. The client is responsible for tracking which emoji it's toggling.
  """
  def remove_encrypted_reaction(message_id, sender_id) do
    query =
      from(r in Reaction,
        where: r.message_id == ^message_id and r.sender_id == ^sender_id,
        order_by: [desc: r.inserted_at],
        limit: 1
      )

    case Repo.one(query) do
      nil -> {:error, :not_found}
      reaction -> Repo.delete(reaction)
    end
  end

  def list_reactions(message_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 200)

    from(r in Reaction,
      where: r.message_id == ^message_id,
      limit: ^limit,
      preload: [:sender]
    )
    |> Repo.all()
  end

  def list_changed_conversation_ids_since(user_id, since) do
    scope_ids =
      from(room in Room,
        join: participant in DmParticipant,
        on: participant.conversation_id == room.conversation_id,
        where:
          room.kind == :dm and
            participant.user_id == ^user_id and
            room.last_mutation_at > ^since,
        select: room.conversation_id,
        distinct: true
      )
      |> Repo.all()

    Enum.uniq(scope_ids)
  end

  # --- Read Positions ---

  def mark_channel_read(user_id, channel_id, message_id) do
    now = DateTime.utc_now()
    last_read_seq = get_channel_message_room_seq(channel_id, message_id)

    result =
      %ChannelReadPosition{}
      |> ChannelReadPosition.changeset(%{
        user_id: user_id,
        channel_id: channel_id,
        last_read_message_id: message_id,
        last_read_seq: last_read_seq,
        last_read_at: now
      })
      |> Repo.insert(
        on_conflict: [
          set: [
            last_read_message_id: message_id,
            last_read_seq: last_read_seq,
            last_read_at: now
          ]
        ],
        conflict_target: [:user_id, :channel_id]
      )

    if match?({:ok, _}, result) do
      Sync.append_scope_events([user_id], "read", "channel", channel_id)
    end

    result
  end

  def mark_dm_read(user_id, conversation_id, message_id) do
    now = DateTime.utc_now()
    last_read_seq = get_conversation_message_room_seq(conversation_id, message_id)

    result =
      %DmReadPosition{}
      |> DmReadPosition.changeset(%{
        user_id: user_id,
        conversation_id: conversation_id,
        last_read_message_id: message_id,
        last_read_seq: last_read_seq,
        last_read_at: now
      })
      |> Repo.insert(
        on_conflict: [
          set: [
            last_read_message_id: message_id,
            last_read_seq: last_read_seq,
            last_read_at: now
          ]
        ],
        conflict_target: [:user_id, :conversation_id]
      )

    if match?({:ok, _}, result) do
      Sync.append_scope_events([user_id], "read", "dm", conversation_id)
    end

    result
  end

  def list_channels_with_read_changes_since(user_id, since) do
    from(p in ChannelReadPosition,
      where: p.user_id == ^user_id and p.last_read_at > ^since,
      select: p.channel_id
    )
    |> Repo.all()
    |> Enum.uniq()
  end

  def list_conversations_with_read_changes_since(user_id, since) do
    from(p in DmReadPosition,
      where: p.user_id == ^user_id and p.last_read_at > ^since,
      select: p.conversation_id
    )
    |> Repo.all()
    |> Enum.uniq()
  end

  @doc """
  Get both channel and DM unread counts in a single DB round-trip using UNION ALL.
  Returns `%{channels: %{channel_id => count}, conversations: %{conversation_id => count}}`.
  """
  def get_all_unread_counts(user_id, channel_ids, conversation_ids)
      when is_list(channel_ids) and is_list(conversation_ids) do
    if channel_ids == [] and conversation_ids == [] do
      %{channels: %{}, conversations: %{}}
    else
      {sql, params} =
        build_unread_union_query(user_id, channel_ids, conversation_ids)

      case Repo.query(sql, params) do
        {:ok, %{rows: rows}} ->
          {channels, conversations} =
            Enum.reduce(rows, {%{}, %{}}, fn [kind, scope_id, count], {ch, dm} ->
              id = Ecto.UUID.cast!(scope_id)

              case kind do
                "channel" -> {Map.put(ch, id, count), dm}
                "dm" -> {ch, Map.put(dm, id, count)}
              end
            end)

          %{channels: channels, conversations: conversations}

        {:error, _} ->
          %{channels: %{}, conversations: %{}}
      end
    end
  end

  defp build_unread_union_query(user_id, channel_ids, conversation_ids) do
    parts = []
    params = []
    param_idx = 1

    {parts, params, param_idx} =
      if channel_ids != [] do
        placeholders =
          Enum.map_join(1..length(channel_ids), ", ", fn i -> "$#{param_idx + i}" end)

        sql = """
        SELECT 'channel' AS kind, m.channel_id::text AS scope_id, COUNT(m.id) AS cnt
        FROM messages m
        JOIN room_events event ON event.message_id = m.id AND event.event_type = 'vesper.message'
        LEFT JOIN channel_read_positions p ON p.channel_id = m.channel_id AND p.user_id = $#{param_idx}
        WHERE m.channel_id IN (#{placeholders})
          AND m.sender_id != $#{param_idx}
          AND (p.last_read_seq IS NULL OR event.room_seq > p.last_read_seq)
        GROUP BY m.channel_id
        HAVING COUNT(m.id) > 0
        """

        new_params = [Ecto.UUID.dump!(user_id) | Enum.map(channel_ids, &Ecto.UUID.dump!/1)]
        {[sql | parts], params ++ new_params, param_idx + 1 + length(channel_ids)}
      else
        {parts, params, param_idx}
      end

    {parts, params, _param_idx} =
      if conversation_ids != [] do
        placeholders =
          Enum.map_join(1..length(conversation_ids), ", ", fn i -> "$#{param_idx + i}" end)

        sql = """
        SELECT 'dm' AS kind, m.conversation_id::text AS scope_id, COUNT(m.id) AS cnt
        FROM messages m
        JOIN room_events event ON event.message_id = m.id AND event.event_type = 'vesper.message'
        LEFT JOIN dm_read_positions p ON p.conversation_id = m.conversation_id AND p.user_id = $#{param_idx}
        WHERE m.conversation_id IN (#{placeholders})
          AND m.sender_id != $#{param_idx}
          AND (p.last_read_seq IS NULL OR event.room_seq > p.last_read_seq)
        GROUP BY m.conversation_id
        HAVING COUNT(m.id) > 0
        """

        new_params =
          [Ecto.UUID.dump!(user_id) | Enum.map(conversation_ids, &Ecto.UUID.dump!/1)]

        {[sql | parts], params ++ new_params, param_idx + 1 + length(conversation_ids)}
      else
        {parts, params, param_idx}
      end

    final_sql = Enum.join(Enum.reverse(parts), " UNION ALL ")
    {final_sql, params}
  end

  def get_channel_unread_counts(user_id, channel_ids) when is_list(channel_ids) do
    if channel_ids == [] do
      %{}
    else
      from(m in Message,
        join: event in RoomEvent,
        on: event.message_id == m.id and event.event_type == "vesper.message",
        left_join: p in ChannelReadPosition,
        on: p.channel_id == m.channel_id and p.user_id == ^user_id,
        where:
          m.channel_id in ^channel_ids and
            m.sender_id != ^user_id and
            (is_nil(p.last_read_seq) or event.room_seq > p.last_read_seq),
        group_by: m.channel_id,
        select: {m.channel_id, count(m.id)}
      )
      |> Repo.all()
      |> Enum.filter(fn {_id, count} -> count > 0 end)
      |> Map.new()
    end
  end

  def get_channel_unread_counts_snapshot(user_id, channel_ids) when is_list(channel_ids) do
    counts = get_channel_unread_counts(user_id, channel_ids)

    channel_ids
    |> Enum.uniq()
    |> Map.new(fn channel_id -> {channel_id, Map.get(counts, channel_id, 0)} end)
  end

  def get_dm_unread_counts(user_id, conversation_ids) when is_list(conversation_ids) do
    if conversation_ids == [] do
      %{}
    else
      from(m in Message,
        join: event in RoomEvent,
        on: event.message_id == m.id and event.event_type == "vesper.message",
        left_join: p in DmReadPosition,
        on: p.conversation_id == m.conversation_id and p.user_id == ^user_id,
        where:
          m.conversation_id in ^conversation_ids and
            m.sender_id != ^user_id and
            (is_nil(p.last_read_seq) or event.room_seq > p.last_read_seq),
        group_by: m.conversation_id,
        select: {m.conversation_id, count(m.id)}
      )
      |> Repo.all()
      |> Enum.filter(fn {_id, count} -> count > 0 end)
      |> Map.new()
    end
  end

  def get_dm_unread_counts_snapshot(user_id, conversation_ids) when is_list(conversation_ids) do
    counts = get_dm_unread_counts(user_id, conversation_ids)

    conversation_ids
    |> Enum.uniq()
    |> Map.new(fn conversation_id -> {conversation_id, Map.get(counts, conversation_id, 0)} end)
  end

  defp get_channel_message_room_seq(channel_id, message_id) do
    from(event in RoomEvent,
      join: message in Message,
      on: message.id == event.message_id,
      where:
        message.channel_id == ^channel_id and
          event.message_id == ^message_id and
          event.event_type == "vesper.message",
      select: event.room_seq,
      limit: 1
    )
    |> Repo.one()
  end

  defp get_conversation_message_room_seq(conversation_id, message_id) do
    from(event in RoomEvent,
      join: message in Message,
      on: message.id == event.message_id,
      where:
        message.conversation_id == ^conversation_id and
          event.message_id == ^message_id and
          event.event_type == "vesper.message",
      select: event.room_seq,
      limit: 1
    )
    |> Repo.one()
  end

  # --- Pinned Messages ---

  def pin_message(channel_id, message_id, pinned_by_id) do
    %PinnedMessage{}
    |> PinnedMessage.changeset(%{
      channel_id: channel_id,
      message_id: message_id,
      pinned_by_id: pinned_by_id
    })
    |> Repo.insert()
  end

  def unpin_message(channel_id, message_id) do
    case Repo.get_by(PinnedMessage, channel_id: channel_id, message_id: message_id) do
      nil -> {:error, :not_found}
      pin -> Repo.delete(pin)
    end
  end

  def list_pinned_messages(channel_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)

    from(p in PinnedMessage,
      where: p.channel_id == ^channel_id,
      order_by: [desc: p.inserted_at],
      limit: ^limit,
      preload: [message: :sender]
    )
    |> Repo.all()
  end

  def is_pinned?(channel_id, message_id) do
    from(p in PinnedMessage,
      where: p.channel_id == ^channel_id and p.message_id == ^message_id
    )
    |> Repo.exists?()
  end

  defp maybe_set_expires_at(%{expires_at: %DateTime{}} = attrs), do: attrs

  defp maybe_set_expires_at(attrs) do
    # If the caller provides disappearing_ttl directly, skip the DB lookup
    ttl = attrs[:disappearing_ttl] || attrs["disappearing_ttl"]

    ttl =
      if is_nil(ttl) do
        lookup_scope_ttl(attrs)
      else
        if is_integer(ttl) and ttl > 0, do: ttl, else: nil
      end

    if ttl do
      expires_at =
        DateTime.utc_now()
        |> DateTime.add(ttl, :second)
        |> DateTime.truncate(:second)

      attrs
      |> Map.put(:expires_at, expires_at)
      |> Map.delete(:disappearing_ttl)
    else
      Map.delete(attrs, :disappearing_ttl)
    end
  end

  defp lookup_scope_ttl(attrs) do
    channel_id = attrs[:channel_id] || attrs["channel_id"]
    conversation_id = attrs[:conversation_id] || attrs["conversation_id"]

    cond do
      channel_id ->
        case Vesper.Repo.get(Vesper.Servers.Channel, channel_id) do
          %{disappearing_ttl: ttl} when is_integer(ttl) and ttl > 0 -> ttl
          _ -> nil
        end

      conversation_id ->
        case Vesper.Repo.get(DmConversation, conversation_id) do
          %{disappearing_ttl: ttl} when is_integer(ttl) and ttl > 0 -> ttl
          _ -> nil
        end

      true ->
        nil
    end
  end
end
