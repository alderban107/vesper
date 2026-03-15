defmodule VesperWeb.PendingWelcomeController do
  use VesperWeb, :controller
  alias Vesper.Encryption
  alias Vesper.Chat
  alias Vesper.Servers

  @doc "GET /api/v1/pending-welcomes/:channel_id — fetch pending welcomes for the current MLS scope"
  def index(conn, %{"channel_id" => scope_id}) do
    user = conn.assigns.current_user
    case authorized_scope(user.id, scope_id) do
      {:ok, authorized_group_id} ->
        render_welcomes(conn, Encryption.get_pending_welcomes(user.id, authorized_group_id))

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  @doc "DELETE /api/v1/pending-welcomes/:id — acknowledge a processed welcome"
  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    welcome = Encryption.get_pending_welcome(id)

    cond do
      is_nil(welcome) ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      welcome.recipient_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      true ->
        Encryption.delete_pending_welcome(id)
        json(conn, %{ok: true})
    end
  end

  defp render_welcomes(conn, welcomes) do
    json(conn, %{
      welcomes:
        Enum.map(welcomes, fn w ->
          %{
            id: w.id,
            welcome_data: Base.encode64(w.welcome_data),
            sender_id: w.sender_id,
            inserted_at: w.inserted_at
          }
        end)
    })
  end

  defp authorized_scope(user_id, "voice:channel:" <> channel_id) do
    case authorize_channel_scope(user_id, channel_id) do
      {:ok, _channel_id} -> {:ok, "voice:channel:#{channel_id}"}
      error -> error
    end
  end

  defp authorized_scope(user_id, "voice:dm:" <> conversation_id) do
    case authorize_conversation_scope(user_id, conversation_id) do
      {:ok, _conversation_id} -> {:ok, "voice:dm:#{conversation_id}"}
      error -> error
    end
  end

  defp authorized_scope(user_id, scope_id) do
    with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
      case authorize_channel_scope(user_id, uuid) do
        {:error, :not_found} -> authorize_conversation_scope(user_id, uuid)
        result -> result
      end
    else
      :error -> {:error, :invalid_scope}
    end
  end

  defp authorize_channel_scope(user_id, channel_id) do
    case Servers.get_channel(channel_id) do
      nil ->
        {:error, :not_found}

      channel ->
        if Servers.user_can_view_channel?(user_id, channel) do
          {:ok, channel_id}
        else
          {:error, :forbidden}
        end
    end
  end

  defp authorize_conversation_scope(user_id, conversation_id) do
    case Chat.get_conversation(conversation_id) do
      nil ->
        {:error, :not_found}

      _conversation ->
        if Chat.user_is_participant?(user_id, conversation_id) do
          {:ok, conversation_id}
        else
          {:error, :forbidden}
        end
    end
  end
end
