defmodule VesperWeb.ChannelHelpers do
  @moduledoc """
  Shared helpers for ChatChannel and DmChannel to avoid code duplication.
  """

  alias Vesper.Chat

  @doc """
  Safely decode a base64 string, returning {:ok, binary} or {:error, reason}.
  """
  def safe_decode64(nil), do: {:error, :missing}

  def safe_decode64(value) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} -> {:ok, decoded}
      :error -> {:error, :invalid_base64}
    end
  end

  def safe_decode64(_), do: {:error, :invalid_type}

  def sender_json(nil), do: nil

  def sender_json(sender) do
    %{
      id: sender.id,
      username: sender.username,
      display_name: sender.display_name,
      avatar_url: sender.avatar_url
    }
  end

  def attachments_json(%{attachments: attachments}) when is_list(attachments) do
    Enum.map(attachments, fn a ->
      %{
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes,
        encrypted: a.encrypted
      }
    end)
  end

  def attachments_json(_), do: []

  def maybe_add_parent(attrs, %{"parent_message_id" => parent_id}) when is_binary(parent_id) do
    Map.put(attrs, :parent_message_id, parent_id)
  end

  def maybe_add_parent(attrs, _params), do: attrs

  def maybe_link_attachments(message, %{"attachment_ids" => ids})
      when is_list(ids) and ids != [] do
    Chat.link_attachments_to_message(ids, message.id)
    Vesper.Repo.preload(message, :attachments, force: true)
  end

  def maybe_link_attachments(message, _params), do: message

  def encrypted_message_payload(message, id_field) do
    payload = %{
      id: message.id,
      ciphertext: Base.encode64(message.ciphertext),
      mls_epoch: message.mls_epoch,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message)
    }

    Map.put(payload, id_field, Map.get(message, id_field))
  end

  def handle_edit_message(id, ciphertext_b64, epoch, socket) do
    with {:ok, ciphertext} <- safe_decode64(ciphertext_b64),
         %{} = message <- Chat.get_message(id),
         true <- message.sender_id == socket.assigns.user_id do
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      case Chat.update_message(message, %{
             ciphertext: ciphertext,
             mls_epoch: epoch,
             edited_at: now
           }) do
        {:ok, _updated} ->
          {:ok, %{message_id: id, ciphertext: ciphertext_b64, mls_epoch: epoch, edited_at: now}}

        {:error, _} ->
          {:error, "could not edit message"}
      end
    else
      {:error, _} -> {:error, "invalid encoding"}
      nil -> {:error, "message not found"}
      false -> {:error, "not the message author"}
    end
  end

  def handle_delete_message(id, user_id) do
    case Chat.get_message(id) do
      nil ->
        {:error, "message not found"}

      message ->
        if message.sender_id != user_id do
          {:error, "not the message author"}
        else
          case Chat.delete_message(message) do
            {:ok, _} -> :ok
            {:error, _} -> {:error, "could not delete message"}
          end
        end
    end
  end

  # Plaintext reaction (no encryption metadata)
  def handle_reaction(action, message_id, emoji, sender_id, expected_scope_field, expected_scope_value) do
    handle_reaction(action, message_id, emoji, sender_id, expected_scope_field, expected_scope_value, %{})
  end

  # Reaction with optional encryption metadata (ciphertext + mls_epoch)
  def handle_reaction(
        action,
        message_id,
        emoji,
        sender_id,
        expected_scope_field,
        expected_scope_value,
        crypto_meta
      ) do
    case Chat.get_message(message_id) do
      nil ->
        {:error, "message not found"}

      message ->
        if Map.get(message, expected_scope_field) != expected_scope_value do
          {:error, "message does not belong to this conversation"}
        else
          case action do
            :add ->
              attrs =
                %{message_id: message_id, sender_id: sender_id, emoji: emoji}
                |> maybe_put(:ciphertext, Map.get(crypto_meta, :ciphertext))
                |> maybe_put(:mls_epoch, Map.get(crypto_meta, :mls_epoch))

              case Chat.add_reaction(attrs) do
                {:ok, _} -> :ok
                {:error, _} -> {:error, "could not add reaction"}
              end

            :remove ->
              case Chat.remove_reaction(message_id, sender_id, emoji) do
                {:ok, _} -> :ok
                {:error, _} -> {:error, "could not remove reaction"}
              end

            :remove_encrypted ->
              # For encrypted reactions, the server can't match on emoji.
              # Remove the most recent reaction from this sender on this message.
              case Chat.remove_encrypted_reaction(message_id, sender_id) do
                {:ok, _} -> :ok
                {:error, _} -> {:error, "could not remove reaction"}
              end
          end
        end
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  @doc """
  Build typing indicator payload. Accepts a socket to use cached username,
  avoiding a DB lookup on every keystroke.
  """
  def typing_start_payload(%{assigns: %{user_id: user_id, username: username}}) do
    %{user_id: user_id, username: username}
  end

  def typing_start_payload(%{assigns: %{user_id: user_id}}) do
    %{user_id: user_id, username: nil}
  end
end
