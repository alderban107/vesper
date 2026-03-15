defmodule VesperWeb.EmojiController do
  use VesperWeb, :controller

  alias Vesper.Chat.FileStorage
  alias Vesper.Servers
  alias Vesper.Servers.Permissions

  @max_emoji_size 1_048_576
  @allowed_types %{
    "image/jpeg" => "jpg",
    "image/png" => "png",
    "image/gif" => "gif",
    "image/webp" => "webp"
  }

  def index(conn, %{"server_id" => server_id}) do
    user = conn.assigns.current_user

    if Servers.user_is_member?(user.id, server_id) do
      emojis =
        server_id
        |> Servers.list_server_emojis()
        |> Enum.map(&emoji_json/1)

      json(conn, %{emojis: emojis})
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a member"})
    end
  end

  def create(conn, %{"server_id" => server_id, "file" => %Plug.Upload{} = upload} = params) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Permissions.manage_roles()) do
      content_type = upload.content_type || "application/octet-stream"

      cond do
        content_type not in Map.keys(@allowed_types) ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{error: "only JPEG, PNG, GIF, and WebP images are allowed"})

        file_too_large?(upload.path) ->
          conn
          |> put_status(:request_entity_too_large)
          |> json(%{error: "emoji too large (max 1MB)"})

        true ->
          case normalized_emoji_name(params["name"], upload.filename) do
            nil ->
              conn
              |> put_status(:unprocessable_entity)
              |> json(%{error: "emoji name must match [a-zA-Z0-9_~-]{2,32}"})

            name ->
              emoji_id = Ecto.UUID.generate()
              ext = Map.fetch!(@allowed_types, content_type)
              storage_key = "#{emoji_id}.#{ext}"

              case FileStorage.store_server_emoji(upload.path, server_id, storage_key) do
                :ok ->
                  attrs = %{
                    id: emoji_id,
                    server_id: server_id,
                    name: name,
                    url: emoji_url(server_id, emoji_id),
                    animated: content_type == "image/gif",
                    storage_key: storage_key
                  }

                  case Servers.create_server_emoji(attrs) do
                    {:ok, emoji} ->
                      conn
                      |> put_status(:created)
                      |> json(%{emoji: emoji_json(emoji)})

                    {:error, changeset} ->
                      FileStorage.delete_server_emoji(server_id, storage_key)

                      if Keyword.has_key?(changeset.errors, :name) do
                        conn
                        |> put_status(:conflict)
                        |> json(%{error: "emoji name already exists"})
                      else
                        conn
                        |> put_status(:unprocessable_entity)
                        |> json(%{error: "could not save emoji"})
                      end
                  end

                {:error, _reason} ->
                  conn
                  |> put_status(:internal_server_error)
                  |> json(%{error: "could not store emoji"})
              end
          end
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "file is required"})
  end

  def delete(conn, %{"server_id" => server_id, "emoji_id" => emoji_id}) do
    user = conn.assigns.current_user

    if Servers.user_can?(user.id, server_id, Permissions.manage_roles()) do
      case Servers.get_server_emoji(server_id, emoji_id) do
        nil ->
          conn |> put_status(:not_found) |> json(%{error: "emoji not found"})

        emoji ->
          case Servers.delete_server_emoji(emoji) do
            {:ok, _} ->
              FileStorage.delete_server_emoji(server_id, emoji.storage_key)
              json(conn, %{ok: true})

            {:error, _} ->
              conn
              |> put_status(:unprocessable_entity)
              |> json(%{error: "could not delete emoji"})
          end
      end
    else
      conn |> put_status(:forbidden) |> json(%{error: "insufficient permissions"})
    end
  end

  def show(conn, %{"server_id" => server_id, "emoji_id" => emoji_id}) do
    case Servers.get_server_emoji(server_id, emoji_id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "emoji not found"})

      emoji ->
        path = FileStorage.emoji_path(server_id, emoji.storage_key)

        if File.exists?(path) do
          conn
          |> put_resp_content_type(content_type_for(emoji.storage_key))
          |> put_resp_header("cache-control", "public, max-age=86400")
          |> send_file(200, path)
        else
          conn |> put_status(:not_found) |> json(%{error: "emoji file not found"})
        end
    end
  end

  defp file_too_large?(path) do
    case File.stat(path) do
      {:ok, %{size: size}} -> size > @max_emoji_size
      _ -> false
    end
  end

  defp normalized_emoji_name(name_param, filename) do
    base_name =
      case name_param do
        value when is_binary(value) and value != "" ->
          value

        _ ->
          filename
          |> Path.basename()
          |> Path.rootname()
      end

    name =
      base_name
      |> String.trim()
      |> String.replace(~r/\s+/, "_")
      |> String.replace(~r/[^a-zA-Z0-9_~-]/, "")
      |> String.slice(0, 32)

    if String.match?(name, ~r/^[a-zA-Z0-9_~-]{2,32}$/), do: name, else: nil
  end

  defp emoji_url(server_id, emoji_id) do
    "/api/v1/servers/#{server_id}/emojis/#{emoji_id}/file"
  end

  defp content_type_for(storage_key) do
    case Path.extname(storage_key) do
      ".jpg" -> "image/jpeg"
      ".png" -> "image/png"
      ".gif" -> "image/gif"
      ".webp" -> "image/webp"
      _ -> "application/octet-stream"
    end
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
end
