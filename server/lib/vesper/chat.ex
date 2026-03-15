defmodule Vesper.Chat do
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

    conversations =
      from(c in DmConversation,
        join: p in DmParticipant,
        on: p.conversation_id == c.id,
        where: p.user_id == ^user_id,
        preload: [participants: :user],
        order_by: [desc: c.inserted_at],
        limit: ^limit
      )
      |> Repo.all()

    conv_ids = Enum.map(conversations, & &1.id)

    # Batch-fetch last message per conversation using a window function
    last_messages =
      if conv_ids != [] do
        from(m in Message,
          where: m.conversation_id in ^conv_ids,
          distinct: m.conversation_id,
          order_by: [m.conversation_id, desc: m.inserted_at],
          preload: [:sender]
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
    Repo.get(Message, id)
  end

  def get_message_with_details(id) do
    Message
    |> Repo.get(id)
    |> case do
      nil -> nil
      message -> Repo.preload(message, [:sender, :attachments])
    end
  end

  def update_message(%Message{} = message, attrs) do
    message
    |> Message.encrypted_changeset(attrs)
    |> Repo.update()
  end

  def delete_message(%Message{} = message) do
    Repo.delete(message)
  end

  def create_message(attrs) do
    attrs = maybe_set_expires_at(attrs)

    %Message{}
    |> Message.encrypted_changeset(attrs)
    |> Repo.insert()
    |> case do
      {:ok, message} -> {:ok, Repo.preload(message, [:sender, :attachments])}
      error -> error
    end
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
    before = Keyword.get(opts, :before)

    query =
      from(m in Message,
        where: m.channel_id == ^channel_id,
        order_by: [desc: m.inserted_at],
        limit: ^limit,
        preload: [:sender, :attachments]
      )

    query =
      if before do
        from(m in query, where: m.inserted_at < ^before)
      else
        query
      end

    Repo.all(query)
  end

  def list_conversation_messages(conversation_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    before = Keyword.get(opts, :before)

    query =
      from(m in Message,
        where: m.conversation_id == ^conversation_id,
        order_by: [desc: m.inserted_at],
        limit: ^limit,
        preload: [:sender, :attachments]
      )

    query =
      if before do
        from(m in query, where: m.inserted_at < ^before)
      else
        query
      end

    Repo.all(query)
  end

  # --- Threads ---

  def list_thread_messages(parent_message_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)

    from(m in Message,
      where: m.parent_message_id == ^parent_message_id,
      order_by: [asc: m.inserted_at],
      limit: ^limit,
      preload: [:sender, :attachments]
    )
    |> Repo.all()
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

  # --- Read Positions ---

  def mark_channel_read(user_id, channel_id, message_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    %ChannelReadPosition{}
    |> ChannelReadPosition.changeset(%{
      user_id: user_id,
      channel_id: channel_id,
      last_read_message_id: message_id,
      last_read_at: now
    })
    |> Repo.insert(
      on_conflict: [set: [last_read_message_id: message_id, last_read_at: now]],
      conflict_target: [:user_id, :channel_id]
    )
  end

  def mark_dm_read(user_id, conversation_id, message_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    %DmReadPosition{}
    |> DmReadPosition.changeset(%{
      user_id: user_id,
      conversation_id: conversation_id,
      last_read_message_id: message_id,
      last_read_at: now
    })
    |> Repo.insert(
      on_conflict: [set: [last_read_message_id: message_id, last_read_at: now]],
      conflict_target: [:user_id, :conversation_id]
    )
  end

  def get_channel_unread_counts(user_id, channel_ids) when is_list(channel_ids) do
    if channel_ids == [] do
      %{}
    else
      # Single query: LEFT JOIN read positions, count messages newer than last_read_at
      # (or all messages if no read position exists)
      from(m in Message,
        left_join: p in ChannelReadPosition,
        on: p.channel_id == m.channel_id and p.user_id == ^user_id,
        where:
          m.channel_id in ^channel_ids and
            m.sender_id != ^user_id and
            (is_nil(p.last_read_at) or m.inserted_at > p.last_read_at),
        group_by: m.channel_id,
        select: {m.channel_id, count(m.id)}
      )
      |> Repo.all()
      |> Enum.filter(fn {_id, count} -> count > 0 end)
      |> Map.new()
    end
  end

  def get_dm_unread_counts(user_id, conversation_ids) when is_list(conversation_ids) do
    if conversation_ids == [] do
      %{}
    else
      # Single query: LEFT JOIN read positions, count messages newer than last_read_at
      from(m in Message,
        left_join: p in DmReadPosition,
        on: p.conversation_id == m.conversation_id and p.user_id == ^user_id,
        where:
          m.conversation_id in ^conversation_ids and
            m.sender_id != ^user_id and
            (is_nil(p.last_read_at) or m.inserted_at > p.last_read_at),
        group_by: m.conversation_id,
        select: {m.conversation_id, count(m.id)}
      )
      |> Repo.all()
      |> Enum.filter(fn {_id, count} -> count > 0 end)
      |> Map.new()
    end
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
    channel_id = attrs[:channel_id] || attrs["channel_id"]
    conversation_id = attrs[:conversation_id] || attrs["conversation_id"]

    ttl =
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

    if ttl do
      expires_at =
        DateTime.utc_now()
        |> DateTime.add(ttl, :second)
        |> DateTime.truncate(:second)

      Map.put(attrs, :expires_at, expires_at)
    else
      attrs
    end
  end
end
