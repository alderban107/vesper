defmodule VesperWeb.RoomCryptoTopologyController do
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Runtime
  alias Vesper.Servers

  def show(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user

    with {:ok, room} <- authorized_room(user.id, scope_id),
         {:ok, resolution} <- resolve_requested_topology(room.id, user.id, params["topology_id"]) do
      json(conn, %{topology: resolution})
    else
      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  def prepare(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user

    with {:ok, room} <- authorized_room(user.id, scope_id),
         :ok <- authorize_migration(user.id, room),
         {:ok, mode} <- parse_mode(params["mode"]),
         {:ok, target_size} <- parse_target_size(params["target_cohort_size"]),
         request_id when is_binary(request_id) and byte_size(request_id) in 8..128 <-
           params["request_id"],
         {:ok, topology} <-
           Encryption.prepare_room_topology(room.id, mode, target_size, request_id),
         {:ok, ready} <-
           Encryption.prepare_room_topology_members(topology.id, room_member_ids(room)) do
      json(conn, %{migration: render_migration(ready)})
    else
      value when is_binary(value) or is_nil(value) ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid migration request"})

      {:error, reason} ->
        render_migration_error(conn, reason)
    end
  end

  def cutover(conn, %{"scope_id" => scope_id, "topology_id" => topology_id}) do
    user = conn.assigns.current_user

    with {:ok, room} <- authorized_room(user.id, scope_id),
         :ok <- authorize_migration(user.id, room),
         {:ok, _appended} <- Encryption.append_room_topology_cutover(room.id, topology_id),
         {:ok, _active} <- Encryption.finalize_room_topology_cutover(room.id, topology_id),
         {:ok, resolution} <- Encryption.resolve_room_topology(room.id, user.id) do
      json(conn, %{topology: resolution})
    else
      {:error, reason} -> render_migration_error(conn, reason)
    end
  end

  def rollback(conn, %{"scope_id" => scope_id, "topology_id" => topology_id} = params) do
    user = conn.assigns.current_user

    with {:ok, room} <- authorized_room(user.id, scope_id),
         :ok <- authorize_migration(user.id, room),
         {:ok, topology} <-
           Encryption.rollback_preparing_room_topology(
             room.id,
             topology_id,
             params["reason"] || "admin_rollback"
           ) do
      json(conn, %{migration: render_migration(topology)})
    else
      {:error, reason} -> render_migration_error(conn, reason)
    end
  end

  def update(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user

    with {:ok, room} <- authorized_room(user.id, scope_id),
         :ok <- authorize_empty_room_cutover(user.id, room),
         {:ok, mode} <- parse_mode(params["mode"]),
         {:ok, target_size} <- parse_target_size(params["target_cohort_size"]),
         {:ok, topology} <- Encryption.prepare_room_topology(room.id, mode, target_size),
         {:ok, _active} <- Encryption.activate_room_topology(topology.id, room.current_seq),
         {:ok, resolution} <- Encryption.resolve_room_topology(room.id, user.id) do
      json(conn, %{topology: resolution})
    else
      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :invalid_topology} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid topology"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not authorized"})

      {:error, :migration_required} ->
        conn |> put_status(:conflict) |> json(%{error: "populated room requires migration"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  defp resolve_requested_topology(room_id, user_id, nil),
    do: Encryption.resolve_room_topology(room_id, user_id)

  defp resolve_requested_topology(room_id, user_id, topology_id) when is_binary(topology_id) do
    case Encryption.resolve_room_topology_generation(room_id, topology_id, user_id) do
      {:error, :topology_not_found} -> {:error, :not_found}
      result -> result
    end
  end

  defp render_migration(topology) do
    %{
      id: topology.id,
      room_id: topology.room_id,
      generation: topology.generation,
      mode: topology.mode,
      state: topology.state,
      request_id: topology.request_id,
      previous_topology_id: topology.previous_topology_id,
      cutover_room_seq: topology.cutover_room_seq,
      failure_reason: topology.failure_reason
    }
  end

  defp room_member_ids(%{channel_id: channel_id}) when is_binary(channel_id) do
    channel_id
    |> Servers.get_channel()
    |> Servers.list_channel_member_ids()
  end

  defp room_member_ids(%{conversation_id: conversation_id}) when is_binary(conversation_id),
    do: Chat.list_participant_ids(conversation_id)

  defp authorize_migration(user_id, %{server_id: server_id}) when is_binary(server_id) do
    if Servers.get_server(server_id).owner_id == user_id, do: :ok, else: {:error, :forbidden}
  end

  defp authorize_migration(_user_id, %{kind: :dm}), do: :ok
  defp authorize_migration(_user_id, _room), do: {:error, :forbidden}

  defp render_migration_error(conn, reason) do
    status =
      case reason do
        :forbidden -> :forbidden
        :topology_not_found -> :not_found
        _ -> :conflict
      end

    conn |> put_status(status) |> json(%{error: Atom.to_string(reason)})
  end

  defp authorize_empty_room_cutover(user_id, %{current_seq: current_seq} = room) do
    cond do
      current_seq > 0 -> {:error, :migration_required}
      not is_binary(room.server_id) -> {:error, :forbidden}
      Servers.get_server(room.server_id).owner_id != user_id -> {:error, :forbidden}
      true -> :ok
    end
  end

  defp parse_mode("single"), do: {:ok, :single}
  defp parse_mode("batched_single"), do: {:ok, :batched_single}
  defp parse_mode("multi_cohort"), do: {:ok, :multi_cohort}
  defp parse_mode(_), do: {:error, :invalid_topology}

  defp parse_target_size(value) when is_integer(value) and value in 2..1000, do: {:ok, value}
  defp parse_target_size(_), do: {:error, :invalid_topology}

  defp authorized_room(user_id, scope_id) do
    with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
      case Servers.get_channel(uuid) do
        nil -> authorized_conversation_room(user_id, uuid)
        _channel -> authorized_channel_room(user_id, uuid)
      end
    else
      :error -> {:error, :invalid_scope}
    end
  end

  defp authorized_channel_room(user_id, channel_id) do
    with channel when not is_nil(channel) <- Servers.get_channel_if_member(channel_id, user_id),
         room when not is_nil(room) <- Runtime.get_room_for_channel(channel.id) do
      {:ok, room}
    else
      nil -> {:error, :forbidden}
    end
  end

  defp authorized_conversation_room(user_id, conversation_id) do
    case Chat.get_conversation(conversation_id) do
      nil ->
        {:error, :not_found}

      _conversation ->
        if Chat.user_is_participant?(user_id, conversation_id) do
          case Runtime.get_room_for_conversation(conversation_id) do
            nil -> {:error, :not_found}
            room -> {:ok, room}
          end
        else
          {:error, :forbidden}
        end
    end
  end
end
