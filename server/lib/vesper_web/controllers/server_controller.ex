defmodule VesperWeb.ServerController do
  use VesperWeb, :controller
  alias Vesper.Servers
  import VesperWeb.ControllerHelpers, only: [format_errors: 1]

  def index(conn, _params) do
    servers = Servers.list_user_servers(conn.assigns.current_user)
    json(conn, %{servers: Enum.map(servers, &server_json/1)})
  end

  def create(conn, params) do
    case Servers.create_server(conn.assigns.current_user, params) do
      {:ok, server} ->
        conn
        |> put_status(:created)
        |> json(%{server: server_json(server)})

      {:error, _} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: "could not create server"})
    end
  end

  def show(conn, %{"id" => id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, id) do
      case Servers.get_server(id) do
        nil -> conn |> put_status(:not_found) |> json(%{error: "not found"})
        server -> json(conn, %{server: server_json(server)})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def update(conn, %{"id" => id} = params) do
    user = conn.assigns.current_user
    server = Servers.get_server(id)

    cond do
      is_nil(server) ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      server.owner_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "only the owner can update the server"})

      true ->
        case Servers.update_server(server, params) do
          {:ok, updated} ->
            json(conn, %{
              server: server_json(updated |> Vesper.Repo.preload([:channels, :emojis]))
            })

          {:error, _} ->
            conn |> put_status(:unprocessable_entity) |> json(%{error: "could not update server"})
        end
    end
  end

  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    server = Servers.get_server(id)

    cond do
      is_nil(server) ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      server.owner_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "only the owner can delete the server"})

      true ->
        Servers.delete_server(server)
        json(conn, %{ok: true})
    end
  end

  def join(conn, %{"invite_code" => invite_code}) do
    user = conn.assigns.current_user

    # Try permanent server invite code first, then invite links
    case Servers.join_server(user, invite_code) do
      {:ok, server} ->
        json(conn, %{server: server_json(server)})

      {:error, :banned} ->
        conn |> put_status(:forbidden) |> json(%{error: "you are banned from this server"})

      {:error, :not_found} ->
        case Servers.use_invite(invite_code, user) do
          {:ok, server} ->
            json(conn, %{server: server_json(server)})

          {:error, :banned} ->
            conn |> put_status(:forbidden) |> json(%{error: "you are banned from this server"})

          {:error, :expired} ->
            conn |> put_status(:gone) |> json(%{error: "invite has expired"})

          {:error, :max_uses_reached} ->
            conn |> put_status(:gone) |> json(%{error: "invite has reached its maximum uses"})

          {:error, :not_found} ->
            conn |> put_status(:not_found) |> json(%{error: "invalid invite code"})
        end
    end
  end

  def join(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "invite_code is required"})
  end

  def leave(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    case Servers.leave_server(user.id, server_id) do
      {:ok, _} ->
        json(conn, %{ok: true})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "not a member"})

      {:error, :owner_cannot_leave} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "Owner cannot leave — transfer ownership or delete the server"})
    end
  end

  def members(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, server_id) do
      members = Servers.list_members(server_id)

      json(conn, %{
        members:
          Enum.map(members, fn m ->
            %{
              id: m.id,
              user_id: m.user_id,
              role: m.role,
              nickname: m.nickname,
              joined_at: m.joined_at,
              user: %{
                id: m.user.id,
                username: m.user.username,
                display_name: m.user.display_name,
                avatar_url: m.user.avatar_url,
                status: m.user.status
              }
            }
          end)
      })
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def kick(conn, %{"server_id" => server_id, "user_id" => user_id}) do
    current_user = conn.assigns.current_user

    cond do
      not Servers.user_can?(current_user.id, server_id, Vesper.Servers.Permissions.kick_members()) ->
        conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})

      user_id == current_user.id ->
        conn |> put_status(:bad_request) |> json(%{error: "cannot kick yourself"})

      true ->
        case Servers.kick_member(server_id, user_id, actor_id: current_user.id) do
          {:ok, _} ->
            json(conn, %{ok: true})

          {:error, :not_found} ->
            conn |> put_status(:not_found) |> json(%{error: "member not found"})
        end
    end
  end

  def ban(conn, %{"server_id" => server_id, "user_id" => user_id} = params) do
    current_user = conn.assigns.current_user

    cond do
      not Servers.user_can?(current_user.id, server_id, Vesper.Servers.Permissions.ban_members()) ->
        conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})

      user_id == current_user.id ->
        conn |> put_status(:bad_request) |> json(%{error: "cannot ban yourself"})

      true ->
        case Servers.ban_member(server_id, user_id, current_user.id, params["reason"]) do
          {:ok, ban} ->
            json(conn, %{
              ban: %{
                id: ban.id,
                server_id: ban.server_id,
                user_id: ban.user_id,
                banned_by_id: ban.banned_by_id,
                reason: ban.reason,
                inserted_at: ban.inserted_at
              }
            })

          {:error, :not_found} ->
            conn |> put_status(:not_found) |> json(%{error: "server not found"})

          {:error, :cannot_ban_owner} ->
            conn |> put_status(:bad_request) |> json(%{error: "cannot ban the server owner"})

          {:error, :already_banned} ->
            conn |> put_status(:conflict) |> json(%{error: "user is already banned"})

          {:error, _changeset} ->
            conn |> put_status(:unprocessable_entity) |> json(%{error: "could not ban user"})
        end
    end
  end

  def unban(conn, %{"server_id" => server_id, "user_id" => user_id}) do
    current_user = conn.assigns.current_user

    if Servers.user_can?(current_user.id, server_id, Vesper.Servers.Permissions.ban_members()) do
      case Servers.unban_member(server_id, user_id, current_user.id) do
        {:ok, _} ->
          json(conn, %{ok: true})

        {:error, :not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "ban not found"})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def bans(conn, %{"server_id" => server_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.ban_members()) do
      limit = parse_limit_param(params["limit"], 100)
      bans = Servers.list_bans(server_id, limit: limit)

      json(conn, %{
        bans:
          Enum.map(bans, fn ban ->
            %{
              id: ban.id,
              server_id: ban.server_id,
              user_id: ban.user_id,
              banned_by_id: ban.banned_by_id,
              reason: ban.reason,
              inserted_at: ban.inserted_at,
              user:
                if ban.user do
                  %{
                    id: ban.user.id,
                    username: ban.user.username,
                    display_name: ban.user.display_name,
                    avatar_url: ban.user.avatar_url
                  }
                end,
              banned_by:
                if ban.banned_by do
                  %{
                    id: ban.banned_by.id,
                    username: ban.banned_by.username,
                    display_name: ban.banned_by.display_name
                  }
                end
            }
          end)
      })
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def audit_logs(conn, %{"server_id" => server_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.manage_server()) do
      limit = parse_limit_param(params["limit"], 100)
      logs = Servers.list_audit_logs(server_id, limit: limit)

      json(conn, %{
        audit_logs:
          Enum.map(logs, fn entry ->
            %{
              id: entry.id,
              server_id: entry.server_id,
              action: entry.action,
              actor_id: entry.actor_id,
              target_user_id: entry.target_user_id,
              target_id: entry.target_id,
              metadata: entry.metadata || %{},
              inserted_at: entry.inserted_at,
              actor:
                if entry.actor do
                  %{
                    id: entry.actor.id,
                    username: entry.actor.username,
                    display_name: entry.actor.display_name
                  }
                end,
              target_user:
                if entry.target_user do
                  %{
                    id: entry.target_user.id,
                    username: entry.target_user.username,
                    display_name: entry.target_user.display_name
                  }
                end
            }
          end)
      })
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  # --- Invites ---

  def list_invites(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.invite_members()) do
      invites = Servers.list_invites(server_id)

      json(conn, %{
        invites:
          Enum.map(invites, fn inv ->
            %{
              id: inv.id,
              code: inv.code,
              role_id: inv.role_id,
              max_uses: inv.max_uses,
              uses: inv.uses,
              expires_at: inv.expires_at,
              creator:
                if inv.creator do
                  %{
                    id: inv.creator.id,
                    username: inv.creator.username,
                    display_name: inv.creator.display_name
                  }
                end,
              inserted_at: inv.inserted_at
            }
          end)
      })
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def create_invite(conn, %{"server_id" => server_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.invite_members()) do
      case Servers.create_invite(server_id, user.id, params) do
        {:ok, invite} ->
          conn
          |> put_status(:created)
          |> json(%{
            invite: %{
              id: invite.id,
              code: invite.code,
              role_id: invite.role_id,
              max_uses: invite.max_uses,
              uses: invite.uses,
              expires_at: invite.expires_at,
              inserted_at: invite.inserted_at
            }
          })

        {:error, :invalid_role} ->
          conn |> put_status(:unprocessable_entity) |> json(%{error: "invalid role_id"})

        {:error, _} ->
          conn |> put_status(:unprocessable_entity) |> json(%{error: "could not create invite"})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def revoke_invite(conn, %{"server_id" => server_id, "invite_id" => invite_id}) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.invite_members()) do
      case Servers.revoke_invite(invite_id, actor_id: user.id) do
        {:ok, _} ->
          json(conn, %{ok: true})

        {:error, :not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "invite not found"})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def invite_code(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.invite_members()) do
      case Servers.get_server(server_id) do
        nil ->
          conn |> put_status(:not_found) |> json(%{error: "not found"})

        server ->
          code = Servers.get_current_invite_code(server)
          json(conn, %{invite_code: code})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  defp server_json(server) do
    %{
      id: server.id,
      name: server.name,
      icon_url: server.icon_url,
      owner_id: server.owner_id,
      channels:
        case server.channels do
          %Ecto.Association.NotLoaded{} -> []
          channels -> Enum.map(channels, &channel_json/1)
        end,
      emojis:
        case server.emojis do
          %Ecto.Association.NotLoaded{} -> []
          emojis -> Enum.map(emojis, &emoji_json/1)
        end,
      inserted_at: server.inserted_at,
      updated_at: server.updated_at
    }
  end

  # --- Roles ---

  def list_roles(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, server_id) do
      roles = Servers.list_roles(server_id)
      json(conn, %{roles: Enum.map(roles, &role_json/1)})
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def create_role(conn, %{"server_id" => server_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.manage_roles()) do
      case Servers.create_role(server_id, params) do
        {:ok, role} ->
          conn |> put_status(:created) |> json(%{role: role_json(role)})

        {:error, changeset} ->
          conn |> put_status(:unprocessable_entity) |> json(%{errors: format_errors(changeset)})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def update_role(conn, %{"server_id" => server_id, "role_id" => role_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.manage_roles()) do
      case Servers.get_role(role_id) do
        nil ->
          conn |> put_status(:not_found) |> json(%{error: "role not found"})

        role ->
          case Servers.update_role(role, params, actor_id: user.id) do
            {:ok, updated} ->
              json(conn, %{role: role_json(updated)})

            {:error, changeset} ->
              conn
              |> put_status(:unprocessable_entity)
              |> json(%{errors: format_errors(changeset)})
          end
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def delete_role(conn, %{"server_id" => server_id, "role_id" => role_id}) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.manage_roles()) do
      case Servers.get_role(role_id) do
        nil ->
          conn |> put_status(:not_found) |> json(%{error: "role not found"})

        role ->
          Servers.delete_role(role, actor_id: user.id)
          json(conn, %{ok: true})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def update_member_roles(conn, %{"server_id" => server_id, "user_id" => target_user_id} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Vesper.Servers.Permissions.manage_roles()) do
      membership = Servers.get_membership(target_user_id, server_id)

      if membership do
        case params["role"] do
          role when is_binary(role) ->
            case Servers.update_membership_role(membership, role, actor_id: user.id) do
              {:ok, _updated} ->
                json(conn, %{ok: true})

              {:error, :invalid_role} ->
                conn |> put_status(:unprocessable_entity) |> json(%{error: "invalid role"})

              {:error, changeset} ->
                conn
                |> put_status(:unprocessable_entity)
                |> json(%{errors: format_errors(changeset)})
            end

          _ ->
            role_ids = params["role_ids"] || []
            Servers.replace_member_roles(membership.id, role_ids, actor_id: user.id)
            json(conn, %{ok: true})
        end
      else
        conn |> put_status(:not_found) |> json(%{error: "member not found"})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  defp role_json(role) do
    %{
      id: role.id,
      server_id: role.server_id,
      name: role.name,
      color: role.color,
      permissions: role.permissions,
      position: role.position
    }
  end

  defp channel_json(channel) do
    %{
      id: channel.id,
      name: channel.name,
      type: channel.type,
      topic: channel.topic,
      position: channel.position,
      disappearing_ttl: channel.disappearing_ttl
    }
  end

  defp emoji_json(emoji) do
    %{
      id: emoji.id,
      name: emoji.name,
      url: emoji.url,
      animated: emoji.animated,
      server_id: emoji.server_id
    }
  end

  defp parse_limit_param(nil, default), do: default

  defp parse_limit_param(limit, default) when is_binary(limit) do
    case Integer.parse(limit) do
      {value, _} when value > 0 -> min(value, 200)
      _ -> default
    end
  end

  defp parse_limit_param(limit, _default) when is_integer(limit) and limit > 0 do
    min(limit, 200)
  end

  defp parse_limit_param(_limit, default), do: default
end
