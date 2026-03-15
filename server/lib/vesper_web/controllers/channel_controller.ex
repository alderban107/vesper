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
        nil ->
          conn |> put_status(:not_found) |> json(%{error: "not found"})

        channel when channel.server_id == server_id ->
          json(conn, %{channel: channel_json(channel)})

        _channel ->
          conn |> put_status(:not_found) |> json(%{error: "not found"})
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
        case maybe_validate_permission_overrides(channel, params) do
          :ok ->
            case maybe_update_channel(channel, params) do
              {:ok, updated} ->
                case maybe_update_permission_overrides(updated, params) do
                  :ok ->
                    json(conn, %{channel: channel_json(updated)})

                  {:error, reason} ->
                    conn
                    |> put_status(:unprocessable_entity)
                    |> json(%{errors: %{permission_overrides: [reason]}})
                end

              {:error, changeset} ->
                conn
                |> put_status(:unprocessable_entity)
                |> json(%{errors: format_errors(changeset)})
            end

          {:error, reason} ->
            conn
            |> put_status(:unprocessable_entity)
            |> json(%{errors: %{permission_overrides: [reason]}})
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

  defp maybe_update_channel(channel, params) do
    if has_channel_update_params?(params) do
      Servers.update_channel(channel, params)
    else
      {:ok, channel}
    end
  end

  defp has_channel_update_params?(params) do
    Enum.any?(
      ["name", "type", "topic", "position", "category_id", "disappearing_ttl", :name, :type, :topic, :position, :category_id, :disappearing_ttl],
      &Map.has_key?(params, &1)
    )
  end

  defp maybe_validate_permission_overrides(channel, params) do
    case Map.get(params, "permission_overrides") || Map.get(params, :permission_overrides) do
      nil ->
        :ok

      overrides ->
        case Servers.validate_channel_permission_overrides(channel, overrides) do
          :ok -> :ok
          {:error, {:invalid_overrides, reason}} -> {:error, reason}
        end
    end
  end

  defp channel_json(channel) do
    %{
      id: channel.id,
      server_id: channel.server_id,
      name: channel.name,
      type: channel.type,
      category_id: channel.category_id,
      topic: channel.topic,
      position: channel.position,
      disappearing_ttl: channel.disappearing_ttl,
      permission_overrides: Servers.list_channel_permission_overrides(channel.id),
      inserted_at: channel.inserted_at,
      updated_at: channel.updated_at
    }
  end

  defp maybe_update_permission_overrides(channel, params) do
    case Map.get(params, "permission_overrides") || Map.get(params, :permission_overrides) do
      nil ->
        :ok

      overrides ->
        case Servers.set_channel_permission_overrides(channel, overrides) do
          {:ok, _result} -> :ok
          {:error, {:invalid_overrides, reason}} -> {:error, reason}
        end
    end
  end
end
