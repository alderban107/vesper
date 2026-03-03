defmodule VesperWeb.AvatarController do
  use VesperWeb, :controller
  alias Vesper.Chat.FileStorage
  alias Vesper.Accounts

  @max_avatar_size 5 * 1024 * 1024  # 5MB
  @allowed_types ~w(image/jpeg image/png image/gif image/webp)
  @ext_map %{
    "image/jpeg" => "jpg",
    "image/png" => "png",
    "image/gif" => "gif",
    "image/webp" => "webp"
  }

  def create(conn, %{"file" => upload}) do
    user = conn.assigns.current_user

    file_size =
      case File.stat(upload.path) do
        {:ok, %{size: size}} -> size
        _ -> 0
      end

    content_type = upload.content_type || "application/octet-stream"

    cond do
      file_size > @max_avatar_size ->
        conn |> put_status(:request_entity_too_large) |> json(%{error: "avatar too large (max 5MB)"})

      content_type not in @allowed_types ->
        conn |> put_status(:unprocessable_entity) |> json(%{error: "only JPEG, PNG, GIF, and WebP images are allowed"})

      true ->
        ext = Map.get(@ext_map, content_type, "bin")
        avatar_dir = FileStorage.avatar_dir()
        File.mkdir_p!(avatar_dir)

        # Remove any existing avatar for this user
        FileStorage.delete_existing_avatar(user.id)

        # Store new avatar
        dest = Path.join(avatar_dir, "#{user.id}.#{ext}")
        File.cp!(upload.path, dest)

        # Update user's avatar_url
        avatar_url = "/api/v1/avatars/#{user.id}"

        case Accounts.update_profile(user, %{avatar_url: avatar_url}) do
          {:ok, updated_user} ->
            conn |> json(%{user: user_json(updated_user)})

          {:error, _} ->
            conn |> put_status(:internal_server_error) |> json(%{error: "could not update avatar"})
        end
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "file is required"})
  end

  def show(conn, %{"user_id" => user_id}) do
    avatar_dir = FileStorage.avatar_dir()

    # Find the avatar file (any extension)
    case find_avatar(avatar_dir, user_id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "no avatar"})

      path ->
        content_type = content_type_from_ext(Path.extname(path))

        conn
        |> put_resp_content_type(content_type)
        |> put_resp_header("cache-control", "public, max-age=86400")
        |> send_file(200, path)
    end
  end

  defp find_avatar(dir, user_id) do
    ~w(.jpg .png .gif .webp)
    |> Enum.find_value(fn ext ->
      path = Path.join(dir, "#{user_id}#{ext}")
      if File.exists?(path), do: path
    end)
  end

  defp content_type_from_ext(".jpg"), do: "image/jpeg"
  defp content_type_from_ext(".png"), do: "image/png"
  defp content_type_from_ext(".gif"), do: "image/gif"
  defp content_type_from_ext(".webp"), do: "image/webp"
  defp content_type_from_ext(_), do: "application/octet-stream"

  defp user_json(user) do
    %{
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      status: user.status
    }
  end
end
