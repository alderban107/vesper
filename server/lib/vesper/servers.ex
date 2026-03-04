defmodule Vesper.Servers do
  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Servers.{Server, Channel, Membership, Role, MemberRole, Permissions, Invite}

  # --- Servers ---

  def create_server(user, attrs) do
    Repo.transaction(fn ->
      server =
        %Server{owner_id: user.id}
        |> Server.changeset(attrs)
        |> Repo.insert!()

      # Auto-create "general" text channel
      %Channel{server_id: server.id}
      |> Channel.changeset(%{name: "general", type: "text", position: 0})
      |> Repo.insert!()

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

      Repo.preload(server, [:channels, :memberships])
    end)
  end

  def list_user_servers(user) do
    from(s in Server,
      join: m in Membership,
      on: m.server_id == s.id,
      where: m.user_id == ^user.id,
      preload: [:channels]
    )
    |> Repo.all()
  end

  def get_server(id) do
    Server
    |> Repo.get(id)
    |> Repo.preload([:channels])
  end

  def get_server!(id) do
    Server
    |> Repo.get!(id)
    |> Repo.preload([:channels])
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
          %Membership{
            user_id: user.id,
            server_id: server.id,
            role: "member",
            joined_at: DateTime.utc_now() |> DateTime.truncate(:second)
          }
          |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :server_id])

          {:ok, server |> Repo.preload(:channels)}
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

  def list_members(server_id) do
    from(m in Membership,
      where: m.server_id == ^server_id,
      preload: [:user]
    )
    |> Repo.all()
  end

  def get_membership(user_id, server_id) do
    Repo.get_by(Membership, user_id: user_id, server_id: server_id)
  end

  def leave_server(user_id, server_id) do
    case Repo.get_by(Membership, user_id: user_id, server_id: server_id) do
      nil -> {:error, :not_found}
      %{role: "owner"} -> {:error, :owner_cannot_leave}
      membership -> Repo.delete(membership)
    end
  end

  def kick_member(server_id, user_id) do
    case Repo.get_by(Membership, user_id: user_id, server_id: server_id) do
      nil -> {:error, :not_found}
      membership -> Repo.delete(membership)
    end
  end

  def user_is_member?(user_id, server_id) do
    from(m in Membership, where: m.user_id == ^user_id and m.server_id == ^server_id)
    |> Repo.exists?()
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
    %Channel{server_id: server_id}
    |> Channel.changeset(attrs)
    |> Repo.insert()
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

  def get_channel!(id) do
    Repo.get!(Channel, id)
  end

  def update_channel(%Channel{} = channel, attrs) do
    channel
    |> Channel.changeset(attrs)
    |> Repo.update()
  end

  def delete_channel(%Channel{} = channel) do
    Repo.delete(channel)
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

  def update_role(%Role{} = role, attrs) do
    role
    |> Role.changeset(attrs)
    |> Repo.update()
  end

  def delete_role(%Role{} = role), do: Repo.delete(role)

  def assign_role(membership_id, role_id) do
    %MemberRole{}
    |> MemberRole.changeset(%{membership_id: membership_id, role_id: role_id})
    |> Repo.insert()
  end

  def replace_member_roles(membership_id, role_ids) do
    Repo.transaction(fn ->
      from(mr in MemberRole, where: mr.membership_id == ^membership_id)
      |> Repo.delete_all()

      for role_id <- role_ids do
        %MemberRole{}
        |> MemberRole.changeset(%{membership_id: membership_id, role_id: role_id})
        |> Repo.insert!()
      end
    end)
  end

  def remove_role(membership_id, role_id) do
    case Repo.get_by(MemberRole, membership_id: membership_id, role_id: role_id) do
      nil -> {:error, :not_found}
      mr -> Repo.delete(mr)
    end
  end

  def get_user_permissions(user_id, server_id) do
    membership = get_membership(user_id, server_id)

    cond do
      is_nil(membership) ->
        0

      membership.role == "owner" ->
        # Owners have all permissions
        Permissions.administrator()

      true ->
        roles =
          from(mr in MemberRole,
            where: mr.membership_id == ^membership.id,
            join: r in Role,
            on: r.id == mr.role_id,
            select: r
          )
          |> Repo.all()

        Permissions.compute_permissions(roles)
    end
  end

  def user_can?(user_id, server_id, permission) do
    perms = get_user_permissions(user_id, server_id)
    Permissions.has_permission?(perms, permission)
  end

  def update_channel_ttl(channel_id, ttl) do
    case Repo.get(Channel, channel_id) do
      nil ->
        {:error, :not_found}

      channel ->
        channel
        |> Channel.changeset(%{disappearing_ttl: ttl})
        |> Repo.update()
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

    %Invite{server_id: server_id, creator_id: creator_id}
    |> Invite.changeset(%{code: code, max_uses: max_uses, expires_at: expires_at})
    |> Repo.insert()
  end

  def list_invites(server_id) do
    from(i in Invite,
      where: i.server_id == ^server_id,
      order_by: [desc: i.inserted_at],
      preload: [:creator]
    )
    |> Repo.all()
  end

  def revoke_invite(invite_id) do
    case Repo.get(Invite, invite_id) do
      nil -> {:error, :not_found}
      invite -> Repo.delete(invite)
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
              result =
                %Membership{
                  user_id: user.id,
                  server_id: server.id,
                  role: "member",
                  joined_at: now
                }
                |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :server_id])

              # Only increment uses when a new membership was actually inserted
              case result do
                {:ok, %Membership{id: id}} when not is_nil(id) ->
                  from(i in Invite, where: i.id == ^invite.id)
                  |> Repo.update_all(inc: [uses: 1])

                _ ->
                  :ok
              end

              {:ok, server |> Repo.preload(:channels)}
            end
        end
    end
  end
end
