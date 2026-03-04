defmodule VesperWeb.ChannelController do
  use VesperWeb, :controller
  alias Vesper.Servers
  import VesperWeb.ControllerHelpers, only: [format_errors: 1]

  def index(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, server_id) do
      channels = Servers.list_channels(server_id)
      json(conn, %{channels: Enum.map(channels, &channel_json/1)})
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def create(conn, %{"server_id" => server_id} = params) do
    user = conn.assigns.current_user
    role = Servers.user_role(user.id, server_id)

    if role in ~w(owner admin) do
      case Servers.create_channel(server_id, params) do
        {:ok, channel} ->
          conn
          |> put_status(:created)
          |> json(%{channel: channel_json(channel)})

        {:error, changeset} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{errors: format_errors(changeset)})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def show(conn, %{"server_id" => server_id, "id" => id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, server_id) do
      case Servers.get_channel(id) do
        nil -> conn |> put_status(:not_found) |> json(%{error: "not found"})
        channel -> json(conn, %{channel: channel_json(channel)})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def update(conn, %{"server_id" => server_id, "id" => id} = params) do
    user = conn.assigns.current_user
    role = Servers.user_role(user.id, server_id)

    if role in ~w(owner admin) do
      channel = Servers.get_channel(id)

      if is_nil(channel) or channel.server_id != server_id do
        conn |> put_status(:not_found) |> json(%{error: "not found"})
      else
        case Servers.update_channel(channel, params) do
          {:ok, updated} ->
            json(conn, %{channel: channel_json(updated)})

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

  def delete(conn, %{"server_id" => server_id, "id" => id}) do
    user = conn.assigns.current_user
    role = Servers.user_role(user.id, server_id)

    if role in ~w(owner admin) do
      channel = Servers.get_channel(id)

      if is_nil(channel) or channel.server_id != server_id do
        conn |> put_status(:not_found) |> json(%{error: "not found"})
      else
        Servers.delete_channel(channel)
        json(conn, %{ok: true})
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  defp channel_json(channel) do
    %{
      id: channel.id,
      server_id: channel.server_id,
      name: channel.name,
      type: channel.type,
      topic: channel.topic,
      position: channel.position,
      disappearing_ttl: channel.disappearing_ttl,
      inserted_at: channel.inserted_at,
      updated_at: channel.updated_at
    }
  end
end
