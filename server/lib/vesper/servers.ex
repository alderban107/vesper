defmodule Vesper.Servers do
  import Bitwise
  import Ecto.Query
  require Logger
  alias Vesper.Repo
  alias Vesper.Accounts

  alias Vesper.Servers.{
    Server,
    Channel,
    Membership,
    Role,
    MemberRole,
    Permissions,
    Invite,
    Emoji,
    ChannelRolePermission,
    ChannelUserPermission,
    ServerBan,
    AuditLog
  }

  alias Vesper.Encryption
  alias Vesper.Runtime
  alias Vesper.Runtime.Room
  alias Vesper.Servers.PermissionsCache

  @channel_override_view_channel 1024

  # --- Servers ---

  def create_server(user, attrs) do
    Repo.transaction(fn ->
      server =
        %Server{owner_id: user.id}
        |> Server.changeset(attrs)
        |> Repo.insert!()

      general_channel =
        %Channel{server_id: server.id}
        |> Channel.changeset(%{
          name: "general",
          type: "text",
          position: 0
        })
        |> Repo.insert!()

      case Runtime.ensure_room_for_channel(general_channel) do
        {:ok, _room} -> :ok
        {:error, changeset} -> Repo.rollback(changeset)
      end

      voice_channel =
        %Channel{server_id: server.id}
        |> Channel.changeset(%{
          name: "General Voice",
          type: "voice",
          position: 1
        })
        |> Repo.insert!()

      case Runtime.ensure_room_for_channel(voice_channel) do
        {:ok, _room} -> :ok
        {:error, changeset} -> Repo.rollback(changeset)
      end

      # Auto-add owner as member with "owner" role
      membership =
        %Membership{
          user_id: user.id,
          server_id: server.id,
          role: "owner",
          joined_at: DateTime.utc_now() |> DateTime.truncate(:second)
        }
        |> Repo.insert!()

      # Auto-create "Admin" role with administrator permission
      admin_role =
        %Role{server_id: server.id}
        |> Role.changeset(%{
          name: "Admin",
          color: "#e74c3c",
          permissions: Permissions.administrator(),
          position: 0
        })
        |> Repo.insert!()

      # Assign admin role to owner
      %MemberRole{}
      |> MemberRole.changeset(%{membership_id: membership.id, role_id: admin_role.id})
      |> Repo.insert!()

      Repo.preload(server, [:channels, :memberships, [emojis: :creator]])
    end)
  end

  def list_user_servers(user, opts \\ []) do
    include_emojis = Keyword.get(opts, :include_emojis, true)

    preloads =
      if include_emojis do
        [:channels, [emojis: :creator]]
      else
        [:channels]
      end

    from(s in Server,
      join: m in Membership,
      on: m.server_id == s.id,
      where: m.user_id == ^user.id,
      preload: ^preloads
    )
    |> Repo.all()
  end

  def list_user_servers_by_ids(user, server_ids, opts \\ []) when is_list(server_ids) do
    if server_ids == [] do
      []
    else
      include_emojis = Keyword.get(opts, :include_emojis, true)

      preloads =
        if include_emojis do
          [:channels, [emojis: :creator]]
        else
          [:channels]
        end

      from(s in Server,
        join: m in Membership,
        on: m.server_id == s.id,
        where: m.user_id == ^user.id and s.id in ^server_ids,
        preload: ^preloads
      )
      |> Repo.all()
    end
  end

  def list_user_channel_ids(user_id) do
    channels =
      from(c in Channel,
        join: m in Membership,
        on: m.server_id == c.server_id,
        where: m.user_id == ^user_id,
        select: c
      )
      |> Repo.all()

    channels
    |> filter_viewable_channels(user_id)
    |> Enum.map(& &1.id)
  end

  def list_viewable_channels(user_id, channel_ids) when is_list(channel_ids) do
    channels =
      from(c in Channel,
        where: c.id in ^channel_ids,
        select: c
      )
      |> Repo.all()

    filter_viewable_channels(channels, user_id)
  end

  defp filter_viewable_channels(channels, user_id) when is_list(channels) do
    if channels == [] do
      []
    else
      # DM channels are always viewable by members — no permission check needed
      {dm_channels, server_channels} =
        Enum.split_with(channels, fn c -> Channel.dm_type?(c.type) end)

      viewable_server_channels = filter_server_channels(server_channels, user_id)
      dm_channels ++ viewable_server_channels
    end
  end

  defp filter_server_channels(channels, _user_id) when channels == [], do: []

  defp filter_server_channels(channels, user_id) do
    server_ids = channels |> Enum.map(& &1.server_id) |> Enum.uniq()

    memberships =
      from(m in Membership,
        where: m.user_id == ^user_id and m.server_id in ^server_ids
      )
      |> Repo.all()
      |> Map.new(&{&1.server_id, &1})

    membership_ids = memberships |> Map.values() |> Enum.map(& &1.id)

    role_ids_by_membership =
      if membership_ids == [] do
        %{}
      else
        from(mr in MemberRole,
          where: mr.membership_id in ^membership_ids,
          select: {mr.membership_id, mr.role_id}
        )
        |> Repo.all()
        |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
      end

    channel_ids = Enum.map(channels, & &1.id)

    role_overrides_by_channel =
      if channel_ids == [] do
        %{}
      else
        from(override in ChannelRolePermission,
          where: override.channel_id in ^channel_ids,
          select: {override.channel_id, override.role_id, override.allow, override.deny}
        )
        |> Repo.all()
        |> Enum.group_by(&elem(&1, 0))
      end

    user_overrides_by_channel =
      if channel_ids == [] do
        %{}
      else
        from(override in ChannelUserPermission,
          where: override.channel_id in ^channel_ids and override.user_id == ^user_id,
          select: {override.channel_id, override.allow, override.deny}
        )
        |> Repo.all()
        |> Map.new(fn {channel_id, allow, deny} -> {channel_id, {allow, deny}} end)
      end

    server_permissions =
      server_ids
      |> Enum.map(fn server_id -> {server_id, PermissionsCache.get(user_id, server_id)} end)
      |> Map.new()

    Enum.filter(channels, fn channel ->
      case Map.get(memberships, channel.server_id) do
        nil ->
          false

        membership ->
          server_permission_bits = Map.get(server_permissions, channel.server_id, 0)

          if Permissions.has_permission?(server_permission_bits, Permissions.administrator()) do
            true
          else
            role_ids = Map.get(role_ids_by_membership, membership.id, [])

            {role_allow, role_deny} =
              Map.get(role_overrides_by_channel, channel.id, [])
              |> Enum.reduce({0, 0}, fn {_channel_id, role_id, allow, deny},
                                        {acc_allow, acc_deny} ->
                if role_id in role_ids do
                  {acc_allow ||| allow, acc_deny ||| deny}
                else
                  {acc_allow, acc_deny}
                end
              end)

            base_allowed = true

            role_adjusted =
              apply_permission_override(
                base_allowed,
                role_allow,
                role_deny,
                @channel_override_view_channel
              )

            {user_allow, user_deny} = Map.get(user_overrides_by_channel, channel.id, {0, 0})

            apply_permission_override(
              role_adjusted,
              user_allow,
              user_deny,
              @channel_override_view_channel
            )
          end
      end
    end)
  end

  def list_user_servers_since(user, since) do
    server_ids =
      from(s in Server,
        join: m in Membership,
        on: m.server_id == s.id,
        where: m.user_id == ^user.id and (m.joined_at > ^since or s.updated_at > ^since),
        select: s.id
      )
      |> Repo.all()

    changed_channel_server_ids =
      from(c in Channel,
        join: m in Membership,
        on: m.server_id == c.server_id,
        where: m.user_id == ^user.id and c.updated_at > ^since,
        select: c.server_id,
        distinct: true
      )
      |> Repo.all()

    changed_server_ids =
      server_ids
      |> Kernel.++(changed_channel_server_ids)
      |> Enum.uniq()

    if changed_server_ids == [] do
      []
    else
      from(s in Server,
        where: s.id in ^changed_server_ids,
        preload: [:channels, [emojis: :creator]]
      )
      |> Repo.all()
    end
  end

  def list_recent_channel_activity(user_id, since) do
    recent_messages =
      from(room in Room,
        join: c in Channel,
        on: c.id == room.channel_id,
        join: mem in Membership,
        on: mem.server_id == c.server_id,
        join: m in Vesper.Chat.Message,
        on: m.id == room.last_message_id,
        where:
          room.kind == :channel and
            mem.user_id == ^user_id and
            room.last_message_at > ^since,
        select: {room.channel_id, m}
      )
      |> Repo.all()

    recent_messages_by_channel =
      recent_messages
      |> Enum.map(&elem(&1, 1))
      |> Repo.preload(:sender)
      |> Map.new(&{&1.id, &1})

    visible_channel_ids =
      list_viewable_channels(
        user_id,
        Enum.map(recent_messages, &elem(&1, 0))
      )
      |> Enum.map(& &1.id)
      |> MapSet.new()

    Enum.flat_map(recent_messages, fn {channel_id, message} ->
      if MapSet.member?(visible_channel_ids, channel_id) do
        [%{channel_id: channel_id, message: Map.fetch!(recent_messages_by_channel, message.id)}]
      else
        []
      end
    end)
  end

  def list_changed_channel_ids_since(user_id, since) do
    channel_ids =
      from(room in Room,
        join: c in Channel,
        on: c.id == room.channel_id,
        join: mem in Membership,
        on: mem.server_id == c.server_id,
        where:
          room.kind == :channel and
            mem.user_id == ^user_id and
            room.last_mutation_at > ^since,
        select: room.channel_id,
        distinct: true
      )
      |> Repo.all()

    list_viewable_channels(user_id, channel_ids)
    |> Enum.map(& &1.id)
  end

  def list_channel_activity_snapshots(user_id, channel_ids) when is_list(channel_ids) do
    visible_channels = list_viewable_channels(user_id, channel_ids)

    latest_messages =
      visible_channels
      |> Enum.map(& &1.id)
      |> Vesper.Chat.get_latest_channel_messages()

    Enum.map(visible_channels, fn channel ->
      %{channel_id: channel.id, message: Map.get(latest_messages, channel.id)}
    end)
  end

  def get_server(id) do
    Server
    |> Repo.get(id)
    |> Repo.preload([:channels, [emojis: :creator]])
  end

  def get_server!(id) do
    Server
    |> Repo.get!(id)
    |> Repo.preload([:channels, [emojis: :creator]])
  end

  def update_server(%Server{} = server, attrs) do
    server
    |> Server.changeset(attrs)
    |> Repo.update()
  end

  def delete_server(%Server{} = server) do
    Repo.delete(server)
  end

  # 24 hours
  @invite_code_ttl_seconds 86_400

  def join_server(user, invite_code) do
    case Repo.get_by(Server, invite_code: invite_code) do
      nil ->
        {:error, :not_found}

      server ->
        # Reject if the permanent code has expired (>24h old)
        if invite_code_stale?(server) do
          # Rotate the stale code so it can't be reused
          rotate_invite_code(server)
          {:error, :not_found}
        else
          if banned?(server.id, user.id) do
            {:error, :banned}
          else
            result =
              %Membership{
                user_id: user.id,
                server_id: server.id,
                role: "member",
                joined_at: DateTime.utc_now() |> DateTime.truncate(:second)
              }
              |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :server_id])

            case result do
              {:ok, %Membership{id: id}} when not is_nil(id) ->
                broadcast_membership_change(server.id, user.id, :member_joined)

              _ ->
                :ok
            end

            {:ok, server |> Repo.preload([:channels, [emojis: :creator]])}
          end
        end
    end
  end

  def get_current_invite_code(server) do
    if invite_code_stale?(server) do
      {:ok, updated} = rotate_invite_code(server)
      updated.invite_code
    else
      server.invite_code
    end
  end

  defp invite_code_stale?(%Server{invite_code_rotated_at: nil}), do: true

  defp invite_code_stale?(%Server{invite_code_rotated_at: rotated_at}) do
    DateTime.diff(DateTime.utc_now(), rotated_at, :second) > @invite_code_ttl_seconds
  end

  defp rotate_invite_code(server) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    server
    |> Ecto.Changeset.change(%{
      invite_code: Server.generate_invite_code(),
      invite_code_rotated_at: now
    })
    |> Repo.update()
  end

  @max_members_default 1000

  def list_members(server_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, @max_members_default)

    from(m in Membership,
      where: m.server_id == ^server_id,
      limit: ^limit,
      preload: [:user]
    )
    |> Repo.all()
  end

  @doc """
  Return all member user IDs for a server. No limit — used by MemberCache
  which needs the full set for accurate notification fanout.
  For paginated REST responses, use `list_members/2` instead.
  """
  def list_member_ids(server_id) do
    from(m in Membership,
      where: m.server_id == ^server_id,
      select: m.user_id
    )
    |> Repo.all()
  end

  @doc """
  List member user IDs for a channel. For server-backed channels, returns
  server members. For DM channels (no server_id), returns channel-direct members.
  """
  def list_channel_member_ids(%Channel{server_id: nil, id: channel_id}) do
    from(m in Membership,
      where: m.channel_id == ^channel_id,
      select: m.user_id
    )
    |> Repo.all()
  end

  def list_channel_member_ids(%Channel{server_id: server_id}) do
    list_member_ids(server_id)
  end

  def get_membership(user_id, server_id) do
    Repo.get_by(Membership, user_id: user_id, server_id: server_id)
  end

  def leave_server(user_id, server_id) do
    case Repo.get_by(Membership, user_id: user_id, server_id: server_id) do
      nil ->
        {:error, :not_found}

      %{role: "owner"} ->
        {:error, :owner_cannot_leave}

      membership ->
        result = Repo.delete(membership)

        case result do
          {:ok, _} ->
            broadcast_membership_change(server_id, user_id, :member_left)
            broadcast_membership_revoked(server_id, user_id, "left")
            queue_membership_crypto_evictions(server_id, user_id, "left")

          _ ->
            :ok
        end

        result
    end
  end

  def kick_member(server_id, user_id, opts \\ []) do
    actor_id = Keyword.get(opts, :actor_id)

    case Repo.get_by(Membership, user_id: user_id, server_id: server_id) do
      nil ->
        {:error, :not_found}

      membership ->
        result = Repo.delete(membership)

        case result do
          {:ok, _} ->
            broadcast_membership_change(server_id, user_id, :member_left)
            broadcast_membership_revoked(server_id, user_id, "kicked")
            queue_membership_crypto_evictions(server_id, user_id, "kicked")
            maybe_log_admin_action(server_id, actor_id, "member_kicked", target_user_id: user_id)

          _ ->
            :ok
        end

        result
    end
  end

  def ban_member(server_id, user_id, banned_by_id, reason \\ nil) do
    with %Server{} = server <- Repo.get(Server, server_id),
         false <- server.owner_id == user_id do
      normalized_reason = blank_to_nil(reason)

      attrs = %{
        server_id: server_id,
        user_id: user_id,
        banned_by_id: banned_by_id,
        reason: normalized_reason
      }

      case %ServerBan{} |> ServerBan.changeset(attrs) |> Repo.insert() do
        {:ok, ban} ->
          case Repo.get_by(Membership, user_id: user_id, server_id: server_id) do
            nil ->
              broadcast_membership_revoked(server_id, user_id, "banned")
              queue_membership_crypto_evictions(server_id, user_id, "banned")

            membership ->
              case Repo.delete(membership) do
                {:ok, _} ->
                  broadcast_membership_change(server_id, user_id, :member_left)
                  broadcast_membership_revoked(server_id, user_id, "banned")
                  queue_membership_crypto_evictions(server_id, user_id, "banned")

                _ ->
                  :ok
              end
          end

          maybe_log_admin_action(server_id, banned_by_id, "member_banned",
            target_user_id: user_id,
            metadata: if(normalized_reason, do: %{"reason" => normalized_reason}, else: %{})
          )

          {:ok, ban}

        {:error, changeset} ->
          if already_banned_changeset?(changeset) do
            {:error, :already_banned}
          else
            {:error, changeset}
          end
      end
    else
      nil ->
        {:error, :not_found}

      true ->
        {:error, :cannot_ban_owner}
    end
  end

  def unban_member(server_id, user_id, unbanned_by_id \\ nil) do
    case Repo.get_by(ServerBan, server_id: server_id, user_id: user_id) do
      nil ->
        {:error, :not_found}

      ban ->
        case Repo.delete(ban) do
          {:ok, _} = result ->
            maybe_log_admin_action(server_id, unbanned_by_id, "member_unbanned",
              target_user_id: user_id
            )

            result

          error ->
            error
        end
    end
  end

  def list_bans(server_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)

    from(b in ServerBan,
      where: b.server_id == ^server_id,
      order_by: [desc: b.inserted_at],
      limit: ^limit,
      preload: [:user, :banned_by]
    )
    |> Repo.all()
  end

  def banned?(server_id, user_id) do
    from(b in ServerBan, where: b.server_id == ^server_id and b.user_id == ^user_id)
    |> Repo.exists?()
  end

  def user_is_member?(_user_id, nil), do: false

  def user_is_member?(user_id, server_id) do
    from(m in Membership, where: m.user_id == ^user_id and m.server_id == ^server_id)
    |> Repo.exists?()
  end

  @doc """
  Check if a user is a member of a channel. For server-backed channels,
  checks server membership. For DM channels, checks channel-direct membership.
  Accepts a Channel struct or a channel_id string.
  """
  def user_is_channel_member?(user_id, %Channel{server_id: nil, id: channel_id}) do
    from(m in Membership, where: m.user_id == ^user_id and m.channel_id == ^channel_id)
    |> Repo.exists?()
  end

  def user_is_channel_member?(user_id, %Channel{server_id: server_id}) do
    user_is_member?(user_id, server_id)
  end

  def user_is_channel_member?(user_id, channel_id) when is_binary(channel_id) do
    case get_channel(channel_id) do
      nil -> false
      channel -> user_is_channel_member?(user_id, channel)
    end
  end

  def user_role(user_id, server_id) do
    from(m in Membership,
      where: m.user_id == ^user_id and m.server_id == ^server_id,
      select: m.role
    )
    |> Repo.one()
  end

  # --- Channels ---

  def create_channel(server_id, attrs) do
    Repo.transaction(fn ->
      normalized_attrs = normalize_channel_attrs(server_id, attrs)

      with :ok <-
             validate_category(server_id, normalized_attrs[:type], normalized_attrs[:category_id]),
           attrs_with_position <- put_channel_position(server_id, normalized_attrs) do
        channel =
          %Channel{server_id: server_id}
          |> Channel.changeset(attrs_with_position)
          |> Repo.insert!()

        case Runtime.ensure_room_for_channel(channel) do
          {:ok, _room} -> channel
          {:error, changeset} -> Repo.rollback(changeset)
        end
      else
        {:error, changeset} ->
          Repo.rollback(changeset)
      end
    end)
    |> case do
      {:ok, channel} -> {:ok, channel}
      {:error, changeset} -> {:error, changeset}
    end
  end

  def list_channels(server_id) do
    from(c in Channel,
      where: c.server_id == ^server_id,
      order_by: [asc: c.position]
    )
    |> Repo.all()
  end

  def get_channel(id) do
    Repo.get(Channel, id)
  end

  @doc """
  Get the disappearing message TTL for a channel. Returns the TTL integer or nil.
  Used by the Chat context to apply TTL without directly querying the Channel schema.
  """
  def get_channel_disappearing_ttl(channel_id) do
    case Repo.get(Channel, channel_id) do
      %{disappearing_ttl: ttl} when is_integer(ttl) and ttl > 0 -> ttl
      _ -> nil
    end
  end

  @doc """
  Create a backing DM channel with memberships. Called by Chat when creating DM conversations.
  Returns {:ok, channel} or {:error, changeset}.
  """
  def create_dm_channel(attrs) do
    channel_type = attrs[:type] || "dm"
    disappearing_ttl = attrs[:disappearing_ttl]
    user_ids = attrs[:user_ids] || []
    joined_at = attrs[:joined_at] || DateTime.utc_now() |> DateTime.truncate(:second)

    channel =
      %Channel{}
      |> Channel.dm_changeset(%{type: channel_type, disappearing_ttl: disappearing_ttl})
      |> Repo.insert!()

    case Runtime.ensure_room_for_channel(channel) do
      {:ok, _room} -> :ok
      {:error, changeset} -> Repo.rollback(changeset)
    end

    for user_id <- user_ids do
      %Membership{
        user_id: user_id,
        channel_id: channel.id,
        role: "member",
        joined_at: joined_at
      }
      |> Repo.insert!()
    end

    channel
  end

  @doc """
  Get a channel only if the user is a member of its server. Single query with join.
  Returns the channel or nil.
  """
  def get_channel_if_member(channel_id, user_id) do
    # Single query that handles both server-based channels and DM channels.
    # Server channels: membership via server_id. DM channels: membership via channel_id.
    Repo.one(
      from(c in Channel,
        where: c.id == ^channel_id,
        left_join: sm in Membership,
        on:
          fragment("? = ? AND ? IS NOT NULL", sm.server_id, c.server_id, c.server_id) and
            sm.user_id == ^user_id,
        left_join: cm in Membership,
        on: cm.channel_id == c.id and cm.user_id == ^user_id and is_nil(c.server_id),
        where: not is_nil(sm.id) or not is_nil(cm.id)
      )
    )
  end

  def get_channel!(id) do
    Repo.get!(Channel, id)
  end

  def update_channel(%Channel{} = channel, attrs) do
    Repo.transaction(fn ->
      normalized_attrs = normalize_channel_attrs(channel.server_id, attrs, channel)
      target_type = normalized_attrs[:type] || channel.type
      target_category_id = normalized_attrs[:category_id]

      with :ok <- validate_category(channel.server_id, target_type, target_category_id),
           attrs_with_position <-
             put_channel_position(channel.server_id, normalized_attrs, channel) do
        old_scope = sibling_scope(channel)

        updated_channel =
          channel
          |> Channel.changeset(attrs_with_position)
          |> Repo.update!()

        normalize_scope_positions(channel.server_id, old_scope, updated_channel.id)
        normalize_scope_positions(channel.server_id, sibling_scope(updated_channel))

        updated_channel
      else
        {:error, changeset} ->
          Repo.rollback(changeset)
      end
    end)
    |> case do
      {:ok, updated_channel} -> {:ok, updated_channel}
      {:error, changeset} -> {:error, changeset}
    end
  end

  def delete_channel(%Channel{} = channel) do
    Repo.transaction(fn ->
      if channel.type == "category" do
        from(c in Channel,
          where: c.server_id == ^channel.server_id and c.category_id == ^channel.id
        )
        |> Repo.update_all(set: [category_id: nil])
      end

      deleted = Repo.delete!(channel)
      normalize_scope_positions(channel.server_id, sibling_scope(channel))

      if channel.type == "category" do
        normalize_scope_positions(channel.server_id, %{kind: :channels, category_id: nil})
      end

      deleted
    end)
  end

  def user_can_view_channel?(user_id, channel_id) when is_binary(channel_id) do
    case get_channel(channel_id) do
      nil -> false
      channel -> user_can_view_channel?(user_id, channel)
    end
  end

  def user_can_view_channel?(user_id, %Channel{} = channel) do
    # DM channels have no permission system — membership alone grants access
    if Channel.dm_type?(channel.type) do
      true
    else
      user_can_channel_permission?(user_id, channel, @channel_override_view_channel)
    end
  end

  def user_can_send_messages_in_channel?(user_id, channel_id) when is_binary(channel_id) do
    case get_channel(channel_id) do
      nil -> false
      channel -> user_can_send_messages_in_channel?(user_id, channel)
    end
  end

  def user_can_send_messages_in_channel?(user_id, %Channel{} = channel) do
    if Channel.dm_type?(channel.type) do
      true
    else
      user_can_channel_permission?(user_id, channel, Permissions.send_messages())
    end
  end

  def list_channel_permission_overrides(channel_id) when is_binary(channel_id) do
    role_overrides =
      from(override in ChannelRolePermission,
        where: override.channel_id == ^channel_id,
        order_by: [asc: override.inserted_at]
      )
      |> Repo.all()
      |> Enum.map(fn override ->
        %{
          role_id: override.role_id,
          allow: permission_names_from_bits(override.allow),
          deny: permission_names_from_bits(override.deny),
          allow_bits: override.allow,
          deny_bits: override.deny
        }
      end)

    user_overrides =
      from(override in ChannelUserPermission,
        where: override.channel_id == ^channel_id,
        order_by: [asc: override.inserted_at]
      )
      |> Repo.all()
      |> Enum.map(fn override ->
        %{
          user_id: override.user_id,
          allow: permission_names_from_bits(override.allow),
          deny: permission_names_from_bits(override.deny),
          allow_bits: override.allow,
          deny_bits: override.deny
        }
      end)

    %{
      roles: role_overrides,
      users: user_overrides
    }
  end

  def validate_channel_permission_overrides(%Channel{} = channel, overrides)
      when is_map(overrides) do
    case parse_and_validate_channel_overrides(channel, overrides) do
      {:ok, _parsed} -> :ok
      {:error, _reason} = error -> error
    end
  end

  def validate_channel_permission_overrides(_channel, _overrides) do
    {:error, {:invalid_overrides, "permission_overrides must be an object"}}
  end

  def set_channel_permission_overrides(%Channel{} = channel, overrides) when is_map(overrides) do
    with {:ok, {role_overrides, user_overrides}} <-
           parse_and_validate_channel_overrides(channel, overrides) do
      Repo.transaction(fn ->
        from(override in ChannelRolePermission, where: override.channel_id == ^channel.id)
        |> Repo.delete_all()

        from(override in ChannelUserPermission, where: override.channel_id == ^channel.id)
        |> Repo.delete_all()

        Enum.each(role_overrides, fn %{id: role_id, allow: allow, deny: deny} ->
          changeset =
            %ChannelRolePermission{}
            |> ChannelRolePermission.changeset(%{
              channel_id: channel.id,
              role_id: role_id,
              allow: allow,
              deny: deny
            })

          case Repo.insert(changeset) do
            {:ok, _} -> :ok
            {:error, insert_changeset} -> Repo.rollback(insert_changeset)
          end
        end)

        Enum.each(user_overrides, fn %{id: user_id, allow: allow, deny: deny} ->
          changeset =
            %ChannelUserPermission{}
            |> ChannelUserPermission.changeset(%{
              channel_id: channel.id,
              user_id: user_id,
              allow: allow,
              deny: deny
            })

          case Repo.insert(changeset) do
            {:ok, _} -> :ok
            {:error, insert_changeset} -> Repo.rollback(insert_changeset)
          end
        end)
      end)
      |> case do
        {:ok, _} ->
          broadcast_permissions_changed(channel.server_id)
          {:ok, list_channel_permission_overrides(channel.id)}

        {:error, %Ecto.Changeset{} = changeset} ->
          {:error, {:invalid_overrides, inspect(changeset.errors)}}

        {:error, error} ->
          {:error, {:invalid_overrides, inspect(error)}}
      end
    end
  end

  def set_channel_permission_overrides(_channel, _overrides) do
    {:error, {:invalid_overrides, "permission_overrides must be an object"}}
  end

  defp parse_and_validate_channel_overrides(channel, overrides) do
    with {:ok, role_overrides} <- parse_override_entries(overrides, :role),
         {:ok, user_overrides} <- parse_override_entries(overrides, :user),
         :ok <- validate_override_roles(channel.server_id, role_overrides),
         :ok <- validate_override_users(channel.server_id, user_overrides) do
      {:ok, {role_overrides, user_overrides}}
    end
  end

  defp user_can_channel_permission?(user_id, %Channel{} = channel, permission_bit) do
    case get_membership(user_id, channel.server_id) do
      nil ->
        false

      membership ->
        server_permissions = get_user_permissions(user_id, channel.server_id)

        if Permissions.has_permission?(server_permissions, Permissions.administrator()) do
          true
        else
          role_ids = member_role_ids(membership.id)
          {role_allow, role_deny} = channel_role_permission_masks(channel.id, role_ids)

          user_override =
            Repo.get_by(ChannelUserPermission,
              channel_id: channel.id,
              user_id: membership.user_id
            )

          base_allowed =
            if permission_bit == @channel_override_view_channel do
              true
            else
              Permissions.has_permission?(server_permissions, permission_bit)
            end

          role_adjusted =
            apply_permission_override(base_allowed, role_allow, role_deny, permission_bit)

          user_allow = if user_override, do: user_override.allow, else: 0
          user_deny = if user_override, do: user_override.deny, else: 0
          apply_permission_override(role_adjusted, user_allow, user_deny, permission_bit)
        end
    end
  end

  defp channel_role_permission_masks(_channel_id, []), do: {0, 0}

  defp channel_role_permission_masks(channel_id, role_ids) do
    from(override in ChannelRolePermission,
      where: override.channel_id == ^channel_id and override.role_id in ^role_ids,
      select: {override.allow, override.deny}
    )
    |> Repo.all()
    |> Enum.reduce({0, 0}, fn {allow, deny}, {acc_allow, acc_deny} ->
      {acc_allow ||| allow, acc_deny ||| deny}
    end)
  end

  defp member_role_ids(membership_id) do
    from(mr in MemberRole,
      where: mr.membership_id == ^membership_id,
      select: mr.role_id
    )
    |> Repo.all()
  end

  defp apply_permission_override(current, allow_mask, deny_mask, permission_bit) do
    cond do
      (deny_mask &&& permission_bit) != 0 -> false
      (allow_mask &&& permission_bit) != 0 -> true
      true -> current
    end
  end

  defp channel_override_permission_map do
    %{
      "view_channel" => @channel_override_view_channel,
      "send_messages" => Permissions.send_messages()
    }
  end

  defp permission_names_from_bits(bits) do
    channel_override_permission_map()
    |> Enum.reduce([], fn {name, bit}, acc ->
      if (bits &&& bit) != 0, do: [name | acc], else: acc
    end)
    |> Enum.reverse()
  end

  defp parse_override_entries(overrides, kind) do
    key = if kind == :role, do: "roles", else: "users"
    atom_key = if kind == :role, do: :roles, else: :users

    case Map.get(overrides, key) || Map.get(overrides, atom_key) do
      nil ->
        {:ok, []}

      entries when is_list(entries) ->
        entries
        |> Enum.reduce_while({:ok, []}, fn entry, {:ok, acc} ->
          case parse_override_entry(entry, kind) do
            {:ok, nil} -> {:cont, {:ok, acc}}
            {:ok, parsed} -> {:cont, {:ok, [parsed | acc]}}
            {:error, reason} -> {:halt, {:error, {:invalid_overrides, reason}}}
          end
        end)
        |> case do
          {:ok, parsed} ->
            deduped =
              parsed
              |> Enum.reverse()
              |> Enum.reduce(%{}, fn item, acc -> Map.put(acc, item.id, item) end)
              |> Map.values()

            {:ok, deduped}

          error ->
            error
        end

      _ ->
        {:error, {:invalid_overrides, "#{key} must be a list"}}
    end
  end

  defp parse_override_entry(entry, kind) when is_map(entry) do
    id_key = if kind == :role, do: "role_id", else: "user_id"
    atom_id_key = if kind == :role, do: :role_id, else: :user_id

    id =
      Map.get(entry, id_key) ||
        Map.get(entry, atom_id_key) ||
        Map.get(entry, "id") ||
        Map.get(entry, :id)

    with true <- (is_binary(id) && id != "") || {:error, "#{id_key} is required"},
         {:ok, allow} <-
           normalize_override_mask(Map.get(entry, "allow") || Map.get(entry, :allow)),
         {:ok, deny} <- normalize_override_mask(Map.get(entry, "deny") || Map.get(entry, :deny)),
         false <- (allow &&& deny) != 0 || {:error, "allow and deny cannot overlap"} do
      if allow == 0 and deny == 0 do
        {:ok, nil}
      else
        {:ok, %{id: id, allow: allow, deny: deny}}
      end
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, "#{id_key} is required"}
      true -> {:error, "allow and deny cannot overlap"}
    end
  end

  defp parse_override_entry(_entry, _kind), do: {:error, "override entries must be objects"}

  defp normalize_override_mask(nil), do: {:ok, 0}

  defp normalize_override_mask(mask) when is_integer(mask) and mask >= 0, do: {:ok, mask}

  defp normalize_override_mask(mask) when is_binary(mask) do
    trimmed = String.trim(mask)

    case Integer.parse(trimmed) do
      {value, ""} when value >= 0 ->
        {:ok, value}

      _ ->
        normalize_override_mask([trimmed])
    end
  end

  defp normalize_override_mask(mask) when is_list(mask) do
    permission_map = channel_override_permission_map()

    Enum.reduce_while(mask, {:ok, 0}, fn item, {:ok, acc} ->
      case normalize_override_item(item, permission_map) do
        {:ok, bit} -> {:cont, {:ok, acc ||| bit}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp normalize_override_mask(_mask), do: {:error, "permission masks must be integers or lists"}

  defp normalize_override_item(item, permission_map) when is_atom(item) do
    normalize_override_item(Atom.to_string(item), permission_map)
  end

  defp normalize_override_item(item, permission_map) when is_binary(item) do
    key = String.downcase(String.trim(item))

    case Map.get(permission_map, key) do
      nil -> {:error, "unsupported permission: #{item}"}
      bit -> {:ok, bit}
    end
  end

  defp normalize_override_item(_item, _permission_map),
    do: {:error, "permissions must be strings"}

  defp validate_override_roles(_server_id, []), do: :ok

  defp validate_override_roles(server_id, role_overrides) do
    role_ids = role_overrides |> Enum.map(& &1.id) |> Enum.uniq()

    count =
      from(r in Role, where: r.server_id == ^server_id and r.id in ^role_ids, select: count(r.id))
      |> Repo.one()

    if count == length(role_ids) do
      :ok
    else
      {:error, {:invalid_overrides, "roles must belong to this server"}}
    end
  end

  defp validate_override_users(_server_id, []), do: :ok

  defp validate_override_users(server_id, user_overrides) do
    user_ids = user_overrides |> Enum.map(& &1.id) |> Enum.uniq()

    count =
      from(m in Membership,
        where: m.server_id == ^server_id and m.user_id in ^user_ids,
        select: count(m.id)
      )
      |> Repo.one()

    if count == length(user_ids) do
      :ok
    else
      {:error, {:invalid_overrides, "users must be members of this server"}}
    end
  end

  defp normalize_channel_attrs(server_id, attrs, channel \\ nil) do
    attrs =
      attrs
      |> Enum.reduce(%{}, fn {key, value}, acc ->
        atom_key =
          case key do
            k when is_atom(k) -> k
            "category_id" -> :category_id
            "disappearing_ttl" -> :disappearing_ttl
            "position" -> :position
            "name" -> :name
            "topic" -> :topic
            "type" -> :type
            _ -> nil
          end

        if atom_key, do: Map.put(acc, atom_key, value), else: acc
      end)

    cond do
      Map.get(attrs, :type) == "category" ->
        attrs
        |> Map.put(:category_id, nil)
        |> Map.put_new(:position, next_position(server_id, %{kind: :categories}))

      Map.has_key?(attrs, :category_id) ->
        attrs

      channel && channel.type != "category" ->
        Map.put(attrs, :category_id, channel.category_id)

      true ->
        Map.put(attrs, :category_id, nil)
    end
  end

  defp validate_category(_server_id, "category", nil), do: :ok
  defp validate_category(_server_id, "category", _category_id), do: invalid_category_changeset()
  defp validate_category(_server_id, _type, nil), do: :ok

  defp validate_category(server_id, _type, category_id) do
    case Repo.get(Channel, category_id) do
      %Channel{server_id: ^server_id, type: "category"} -> :ok
      _ -> invalid_category_changeset()
    end
  end

  defp invalid_category_changeset do
    {:error,
     %Channel{}
     |> Channel.changeset(%{name: "invalid", type: "text"})
     |> Ecto.Changeset.add_error(:category_id, "is not a valid category")}
  end

  defp put_channel_position(server_id, attrs, channel \\ nil) do
    target_type = attrs[:type] || (channel && channel.type) || "text"

    target_category_id =
      if target_type == "category",
        do: nil,
        else: Map.get(attrs, :category_id, channel && channel.category_id)

    scope =
      if target_type == "category" do
        %{kind: :categories}
      else
        %{kind: :channels, category_id: target_category_id}
      end

    existing_ids =
      sibling_query(server_id, scope, channel && channel.id)
      |> select([c], c.id)
      |> Repo.all()

    requested_position =
      case attrs[:position] do
        pos when is_integer(pos) ->
          pos

        pos when is_binary(pos) ->
          case Integer.parse(pos) do
            {value, _} -> value
            :error -> length(existing_ids)
          end

        _ ->
          length(existing_ids)
      end

    position = requested_position |> max(0) |> min(length(existing_ids))

    reordered_ids =
      existing_ids
      |> List.insert_at(position, (channel && channel.id) || "__new__")
      |> Enum.with_index()

    Enum.each(reordered_ids, fn
      {"__new__", _index} ->
        :ok

      {id, index} ->
        from(c in Channel, where: c.id == ^id)
        |> Repo.update_all(set: [position: index])
    end)

    Map.put(attrs, :position, position)
  end

  defp normalize_scope_positions(server_id, scope, exclude_id \\ nil)

  defp normalize_scope_positions(_server_id, nil, _exclude_id), do: :ok

  defp normalize_scope_positions(server_id, scope, exclude_id) do
    sibling_query(server_id, scope, exclude_id)
    |> Repo.all()
    |> Enum.with_index()
    |> Enum.each(fn {channel, index} ->
      if channel.position != index do
        from(c in Channel, where: c.id == ^channel.id)
        |> Repo.update_all(set: [position: index])
      end
    end)
  end

  defp sibling_scope(%Channel{type: "category"}), do: %{kind: :categories}

  defp sibling_scope(%Channel{category_id: category_id}),
    do: %{kind: :channels, category_id: category_id}

  defp sibling_query(server_id, %{kind: :categories}, exclude_id) do
    from(c in Channel,
      where: c.server_id == ^server_id and c.type == "category",
      order_by: [asc: c.position, asc: c.inserted_at]
    )
    |> maybe_exclude(exclude_id)
  end

  defp sibling_query(server_id, %{kind: :channels, category_id: nil}, exclude_id) do
    from(c in Channel,
      where: c.server_id == ^server_id and c.type != "category" and is_nil(c.category_id),
      order_by: [asc: c.position, asc: c.inserted_at]
    )
    |> maybe_exclude(exclude_id)
  end

  defp sibling_query(server_id, %{kind: :channels, category_id: category_id}, exclude_id) do
    from(c in Channel,
      where: c.server_id == ^server_id and c.type != "category" and c.category_id == ^category_id,
      order_by: [asc: c.position, asc: c.inserted_at]
    )
    |> maybe_exclude(exclude_id)
  end

  defp maybe_exclude(query, nil), do: query
  defp maybe_exclude(query, id), do: where(query, [c], c.id != ^id)

  defp next_position(server_id, scope) do
    sibling_query(server_id, scope, nil)
    |> select([c], count(c.id))
    |> Repo.one()
  end

  # --- Roles ---

  def list_roles(server_id) do
    from(r in Role, where: r.server_id == ^server_id, order_by: [asc: r.position])
    |> Repo.all()
  end

  def get_role(id), do: Repo.get(Role, id)

  def create_role(server_id, attrs) do
    %Role{server_id: server_id}
    |> Role.changeset(attrs)
    |> Repo.insert()
  end

  def update_role(%Role{} = role, attrs, opts \\ []) do
    actor_id = Keyword.get(opts, :actor_id)

    result =
      role
      |> Role.changeset(attrs)
      |> Repo.update()

    if match?({:ok, _}, result) do
      broadcast_permissions_changed(role.server_id)

      maybe_log_admin_action(role.server_id, actor_id, "role_updated",
        target_id: role.id,
        metadata: role_update_metadata(attrs)
      )
    end

    result
  end

  def delete_role(%Role{} = role, opts \\ []) do
    actor_id = Keyword.get(opts, :actor_id)

    result = Repo.delete(role)

    if match?({:ok, _}, result) do
      broadcast_permissions_changed(role.server_id)
      maybe_log_admin_action(role.server_id, actor_id, "role_deleted", target_id: role.id)
    end

    result
  end

  def assign_role(membership_id, role_id) do
    result =
      %MemberRole{}
      |> MemberRole.changeset(%{membership_id: membership_id, role_id: role_id})
      |> Repo.insert()

    if match?({:ok, _}, result) do
      membership = Repo.get(Membership, membership_id)
      if membership, do: broadcast_permissions_changed(membership.server_id)
    end

    result
  end

  def replace_member_roles(membership_id, role_ids, opts \\ []) do
    actor_id = Keyword.get(opts, :actor_id)

    result =
      Repo.transaction(fn ->
        from(mr in MemberRole, where: mr.membership_id == ^membership_id)
        |> Repo.delete_all()

        for role_id <- role_ids do
          %MemberRole{}
          |> MemberRole.changeset(%{membership_id: membership_id, role_id: role_id})
          |> Repo.insert!()
        end
      end)

    if match?({:ok, _}, result) do
      membership = Repo.get(Membership, membership_id)

      if membership do
        broadcast_permissions_changed(membership.server_id)

        maybe_log_admin_action(membership.server_id, actor_id, "member_roles_updated",
          target_user_id: membership.user_id,
          metadata: %{"role_ids" => role_ids}
        )
      end
    end

    result
  end

  def update_membership_role(membership, role, opts \\ [])

  def update_membership_role(%Membership{} = membership, role, opts)
      when role in ~w(owner admin moderator member) do
    actor_id = Keyword.get(opts, :actor_id)

    result =
      membership
      |> Membership.changeset(%{role: role})
      |> Repo.update()

    if match?({:ok, _}, result) do
      broadcast_permissions_changed(membership.server_id)

      maybe_log_admin_action(membership.server_id, actor_id, "member_role_updated",
        target_user_id: membership.user_id,
        metadata: %{"role" => role}
      )
    end

    result
  end

  def update_membership_role(%Membership{}, _role, _opts), do: {:error, :invalid_role}

  def remove_role(membership_id, role_id) do
    case Repo.get_by(MemberRole, membership_id: membership_id, role_id: role_id) do
      nil ->
        {:error, :not_found}

      mr ->
        result = Repo.delete(mr)

        if match?({:ok, _}, result) do
          membership = Repo.get(Membership, membership_id)
          if membership, do: broadcast_permissions_changed(membership.server_id)
        end

        result
    end
  end

  # DM channels have no server — return full permissions (member-only access)
  def get_user_permissions(_user_id, nil), do: 0

  def get_user_permissions(user_id, server_id) do
    # Single query: fetch membership + all role permissions in one round-trip
    result =
      from(m in Membership,
        where: m.user_id == ^user_id and m.server_id == ^server_id,
        left_join: mr in MemberRole,
        on: mr.membership_id == m.id,
        left_join: r in Role,
        on: r.id == mr.role_id,
        select: {m.role, r.permissions}
      )
      |> Repo.all()

    case result do
      [] ->
        0

      rows ->
        {membership_role, _} = hd(rows)
        base_permissions = default_permissions_for_membership_role(membership_role)

        role_permissions =
          rows
          |> Enum.map(fn {_, perms} -> perms end)
          |> Enum.reject(&is_nil/1)
          |> Enum.reduce(0, fn perms, acc -> Bitwise.bor(acc, perms) end)

        Bitwise.bor(base_permissions, role_permissions)
    end
  end

  def user_can?(user_id, server_id, permission) do
    perms = get_user_permissions(user_id, server_id)
    Permissions.has_permission?(perms, permission)
  end

  # --- Emojis ---

  def list_server_emojis(server_id) do
    from(e in Emoji,
      where: e.server_id == ^server_id,
      order_by: [asc: e.name, asc: e.inserted_at],
      preload: [:creator]
    )
    |> Repo.all()
  end

  def get_server_emoji(server_id, emoji_id) do
    Emoji
    |> Repo.get_by(id: emoji_id, server_id: server_id)
    |> Repo.preload(:creator)
  end

  def create_server_emoji(attrs) do
    %Emoji{}
    |> Emoji.changeset(attrs)
    |> Repo.insert()
    |> case do
      {:ok, emoji} -> {:ok, Repo.preload(emoji, :creator)}
      error -> error
    end
  end

  def update_server_emoji(%Emoji{} = emoji, name) do
    emoji
    |> Emoji.rename_changeset(name)
    |> Repo.update()
    |> case do
      {:ok, emoji} -> {:ok, Repo.preload(emoji, :creator)}
      error -> error
    end
  end

  def delete_server_emoji(%Emoji{} = emoji) do
    Repo.delete(emoji)
  end

  def update_channel_ttl(channel_id, ttl) do
    case Repo.get(Channel, channel_id) do
      nil ->
        {:error, :not_found}

      channel ->
        result =
          channel
          |> Channel.changeset(%{disappearing_ttl: ttl})
          |> Repo.update()

        if match?({:ok, _}, result) do
          Phoenix.PubSub.broadcast(
            Vesper.PubSub,
            "channel:settings:#{channel_id}",
            {:ttl_changed, ttl}
          )
        end

        result
    end
  end

  # --- Invites ---

  def create_invite(server_id, creator_id, attrs \\ %{}) do
    code = Invite.generate_code()

    expires_at =
      case attrs["expires_in_seconds"] || attrs[:expires_in_seconds] do
        seconds when is_integer(seconds) and seconds > 0 ->
          DateTime.utc_now()
          |> DateTime.add(seconds, :second)
          |> DateTime.truncate(:second)

        _ ->
          nil
      end

    max_uses =
      case attrs["max_uses"] || attrs[:max_uses] do
        n when is_integer(n) and n > 0 -> n
        _ -> nil
      end

    with {:ok, role_id} <- normalize_invite_role_id(server_id, attrs) do
      result =
        %Invite{server_id: server_id, creator_id: creator_id}
        |> Invite.changeset(%{
          code: code,
          max_uses: max_uses,
          expires_at: expires_at,
          role_id: role_id
        })
        |> Repo.insert()

      case result do
        {:ok, invite} ->
          maybe_log_admin_action(server_id, creator_id, "invite_created",
            target_id: invite.id,
            metadata: %{
              "code" => invite.code,
              "max_uses" => invite.max_uses,
              "expires_at" => invite.expires_at,
              "role_id" => invite.role_id
            }
          )

        _ ->
          :ok
      end

      result
    end
  end

  def list_invites(server_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)

    from(i in Invite,
      where: i.server_id == ^server_id,
      order_by: [desc: i.inserted_at],
      limit: ^limit,
      preload: [:creator]
    )
    |> Repo.all()
  end

  def revoke_invite(invite_id, opts \\ []) do
    actor_id = Keyword.get(opts, :actor_id)

    case Repo.get(Invite, invite_id) do
      nil ->
        {:error, :not_found}

      invite ->
        case Repo.delete(invite) do
          {:ok, _} = result ->
            maybe_log_admin_action(invite.server_id, actor_id, "invite_revoked",
              target_id: invite.id,
              metadata: %{"code" => invite.code}
            )

            result

          error ->
            error
        end
    end
  end

  def use_invite(invite_code, user) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case Repo.get_by(Invite, code: invite_code) do
      nil ->
        {:error, :not_found}

      invite ->
        cond do
          invite.expires_at && DateTime.compare(now, invite.expires_at) == :gt ->
            {:error, :expired}

          invite.max_uses && invite.uses >= invite.max_uses ->
            {:error, :max_uses_reached}

          true ->
            server = get_server(invite.server_id)

            if is_nil(server) do
              {:error, :not_found}
            else
              if banned?(server.id, user.id) do
                {:error, :banned}
              else
                result =
                  %Membership{
                    user_id: user.id,
                    server_id: server.id,
                    role: "member",
                    joined_at: now
                  }
                  |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :server_id])

                # Only increment uses and broadcast when a new membership was actually inserted
                case result do
                  {:ok, %Membership{id: id}} when not is_nil(id) ->
                    maybe_assign_invite_role(id, invite.role_id)

                    # Atomic increment with max_uses guard to prevent race condition
                    from(i in Invite,
                      where: i.id == ^invite.id,
                      where: is_nil(i.max_uses) or i.uses < i.max_uses
                    )
                    |> Repo.update_all(inc: [uses: 1])

                    broadcast_membership_change(server.id, user.id, :member_joined)

                  _ ->
                    :ok
                end

                {:ok, server |> Repo.preload([:channels, [emojis: :creator]])}
              end
            end
        end
    end
  end

  # --- Audit Logs ---

  def create_audit_log(attrs) do
    %AuditLog{}
    |> AuditLog.changeset(attrs)
    |> Repo.insert()
  end

  def list_audit_logs(server_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)

    from(a in AuditLog,
      where: a.server_id == ^server_id,
      order_by: [desc: a.inserted_at],
      limit: ^limit,
      preload: [:actor, :target_user]
    )
    |> Repo.all()
  end

  def log_admin_action(server_id, actor_id, action, opts \\ []) do
    metadata = normalize_audit_metadata(Keyword.get(opts, :metadata, %{}))

    attrs = %{
      server_id: server_id,
      actor_id: actor_id,
      action: action,
      target_user_id: Keyword.get(opts, :target_user_id),
      target_id: Keyword.get(opts, :target_id),
      metadata: metadata
    }

    create_audit_log(attrs)
  end

  # --- Private Helpers ---

  defp maybe_log_admin_action(_server_id, nil, _action, _opts), do: :ok

  defp maybe_log_admin_action(server_id, actor_id, action, opts) do
    _ = log_admin_action(server_id, actor_id, action, opts)
    :ok
  end

  defp normalize_audit_metadata(metadata) when is_map(metadata), do: metadata
  defp normalize_audit_metadata(_), do: %{}

  defp blank_to_nil(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp blank_to_nil(value), do: value

  defp already_banned_changeset?(%Ecto.Changeset{} = changeset) do
    Enum.any?(changeset.errors, fn
      {:user_id, {_message, meta}} -> meta[:constraint] == :unique
      _ -> false
    end)
  end

  defp role_update_metadata(attrs) when is_map(attrs) do
    attrs
    |> Enum.filter(fn {key, _value} ->
      key in [:name, :color, :permissions, :position, "name", "color", "permissions", "position"]
    end)
    |> Enum.into(%{})
  end

  defp role_update_metadata(attrs) when is_list(attrs) do
    attrs
    |> Enum.filter(fn {key, _value} ->
      key in [:name, :color, :permissions, :position, "name", "color", "permissions", "position"]
    end)
    |> Enum.into(%{})
  end

  defp role_update_metadata(_attrs), do: %{}

  defp broadcast_membership_change(server_id, user_id, event) do
    Phoenix.PubSub.broadcast(
      Vesper.PubSub,
      "server:members:#{server_id}",
      {event, server_id, user_id}
    )

    VesperWeb.Endpoint.broadcast("presence:server:#{server_id}", "server_members_updated", %{
      server_id: server_id,
      event: event,
      user_id: user_id
    })
  end

  defp broadcast_membership_revoked(server_id, user_id, reason) do
    channel_ids =
      server_id
      |> list_channels()
      |> Enum.reject(&(&1.type == "category"))
      |> Enum.map(& &1.id)

    VesperWeb.Endpoint.broadcast("user:#{user_id}", "server_membership_revoked", %{
      server_id: server_id,
      channel_ids: channel_ids,
      reason: reason
    })
  end

  defp queue_membership_crypto_evictions(server_id, user_id, reason) do
    channel_ids =
      server_id
      |> list_channels()
      |> Enum.filter(&(&1.type == "text"))
      |> Enum.map(& &1.id)

    target_device_ids =
      user_id
      |> Accounts.list_devices()
      |> Enum.reject(&(not is_nil(&1.revoked_at) or &1.trust_state == "revoked"))
      |> Enum.map(& &1.client_id)
      |> case do
        [] -> [nil]
        device_ids -> device_ids
      end

    evictions =
      for channel_id <- channel_ids, target_device_id <- target_device_ids do
        %{
          scope_kind: "channel",
          scope_id: channel_id,
          group_id: channel_id,
          server_id: server_id,
          target_user_id: user_id,
          target_device_id: target_device_id,
          reason: reason
        }
      end

    case Encryption.queue_scope_crypto_evictions(evictions) do
      :ok ->
        :ok

      other ->
        Logger.warning("Could not queue MLS evictions for membership revoke",
          extra: %{
            server_id: server_id,
            target_user_id: user_id,
            reason: inspect(other)
          }
        )

        :ok
    end
  end

  defp broadcast_permissions_changed(server_id) do
    Phoenix.PubSub.broadcast(
      Vesper.PubSub,
      "server:permissions:#{server_id}",
      {:permissions_changed, server_id}
    )
  end

  defp normalize_invite_role_id(server_id, attrs) do
    case attrs["role_id"] || attrs[:role_id] do
      nil ->
        {:ok, nil}

      "" ->
        {:ok, nil}

      role_id when is_binary(role_id) ->
        with {:ok, role_uuid} <- Ecto.UUID.cast(role_id),
             true <-
               Repo.exists?(
                 from(r in Role, where: r.id == ^role_uuid and r.server_id == ^server_id)
               ) do
          {:ok, role_uuid}
        else
          _ -> {:error, :invalid_role}
        end

      _ ->
        {:error, :invalid_role}
    end
  end

  defp maybe_assign_invite_role(_membership_id, nil), do: :ok

  defp maybe_assign_invite_role(membership_id, role_id) do
    %MemberRole{}
    |> MemberRole.changeset(%{membership_id: membership_id, role_id: role_id})
    |> Repo.insert(on_conflict: :nothing, conflict_target: [:membership_id, :role_id])

    :ok
  end

  defp default_permissions_for_membership_role("owner"), do: Permissions.administrator()

  defp default_permissions_for_membership_role("admin"), do: Permissions.administrator()

  defp default_permissions_for_membership_role("moderator") do
    Permissions.send_messages() |||
      Permissions.manage_messages() |||
      Permissions.kick_members() |||
      Permissions.ban_members()
  end

  defp default_permissions_for_membership_role("member"), do: Permissions.send_messages()

  defp default_permissions_for_membership_role(_role), do: 0
end
