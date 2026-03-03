defmodule VesperWeb.AttachmentController do
  use VesperWeb, :controller
  alias Vesper.Chat.{Attachment, FileStorage}
  alias Vesper.Repo

  def create(conn, %{"file" => upload} = params) do
    max_size = FileStorage.max_upload_size()

    file_size =
      case File.stat(upload.path) do
        {:ok, %{size: size}} -> size
        _ -> 0
      end

    if file_size > max_size do
      conn |> put_status(:request_entity_too_large) |> json(%{error: "file too large"})
    else
      case FileStorage.store(upload.path, upload.filename) do
        {:ok, storage_key} ->
          expiry_days = Application.get_env(:vesper, :file_expiry_days, 30)

          expires_at =
            DateTime.utc_now()
            |> DateTime.add(expiry_days * 86_400, :second)
            |> DateTime.truncate(:second)

          attrs = %{
            filename: upload.filename,
            content_type: upload.content_type,
            size_bytes: file_size,
            storage_key: storage_key,
            encrypted: params["encrypted"] == "true",
            expires_at: expires_at
          }

          # Link to message if provided (optional now)
          attrs =
            case params["message_id"] do
              nil -> attrs
              id -> Map.put(attrs, :message_id, id)
            end

          case %Attachment{} |> Attachment.changeset(attrs) |> Repo.insert() do
            {:ok, attachment} ->
              conn |> put_status(:created) |> json(%{attachment: attachment_json(attachment)})

            {:error, _changeset} ->
              conn |> put_status(:unprocessable_entity) |> json(%{error: "could not save attachment"})
          end

        {:error, reason} ->
          conn |> put_status(:internal_server_error) |> json(%{error: to_string(reason)})
      end
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "file is required"})
  end

  def show(conn, %{"id" => id}) do
    case Repo.get(Attachment, id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      attachment ->
        path = FileStorage.get_path(attachment.storage_key)

        if File.exists?(path) do
          conn
          |> put_resp_content_type(attachment.content_type || "application/octet-stream")
          |> put_resp_header(
            "content-disposition",
            ~s(attachment; filename="#{attachment.filename}")
          )
          |> send_file(200, path)
        else
          conn |> put_status(:not_found) |> json(%{error: "file not found"})
        end
    end
  end

  defp attachment_json(attachment) do
    %{
      id: attachment.id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      message_id: attachment.message_id,
      encrypted: attachment.encrypted,
      expires_at: attachment.expires_at
    }
  end
end
