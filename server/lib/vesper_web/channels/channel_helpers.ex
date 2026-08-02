defmodule VesperWeb.ChannelHelpers do
  @moduledoc """
  Shared helpers for ChatChannel and DmChannel to avoid code duplication.
  """

  alias Vesper.{Chat, Encryption, Runtime}

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

  def decode_history_signing_key(params) do
    case Map.get(params, "history_signing_public_key") do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        case Base.decode64(value) do
          {:ok, decoded} when byte_size(decoded) == 32 -> {:ok, decoded}
          _ -> {:error, :invalid_history_signing_key}
        end

      _ ->
        {:error, :invalid_history_signing_key}
    end
  end

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
      base = %{
        id: a.id,
        size_bytes: a.size_bytes,
        encrypted: a.encrypted
      }

      # For encrypted attachments, filename and content_type are inside the
      # encrypted message payload — don't leak them in plaintext broadcasts.
      if a.encrypted do
        base
      else
        Map.merge(base, %{filename: a.filename, content_type: a.content_type})
      end
    end)
  end

  def attachments_json(_), do: []

  def reactions_json(%{reactions: reactions}) when is_list(reactions) do
    Enum.map(reactions, fn r ->
      %{
        id: r.id,
        emoji: r.emoji,
        ciphertext: r.ciphertext,
        mls_epoch: r.mls_epoch,
        encryption_scheme: r.encryption_scheme,
        encryption_group_id: r.encryption_group_id,
        sender_id: r.sender_id,
        inserted_at: r.inserted_at
      }
    end)
  end

  def reactions_json(_), do: []

  def maybe_add_parent(attrs, params) do
    case resolve_message_relations(params, nil, nil, validate_scope?: false) do
      {:ok, relations} ->
        attrs
        |> maybe_put(:parent_message_id, relations.parent_message_id)
        |> maybe_put(:thread_root_message_id, relations.thread_root_message_id)
        |> maybe_put(:reply_to_message_id, relations.reply_to_message_id)
        |> Map.put(:is_reply, relations.is_reply)

      {:error, _reason} ->
        attrs
    end
  end

  def maybe_add_parent_id(attrs, parent_id) when is_binary(parent_id) do
    Map.put(attrs, :parent_message_id, parent_id)
  end

  def maybe_add_parent_id(attrs, _parent_id), do: attrs

  def resolve_message_relations(params, scope_field, scope_id, opts \\ []) do
    validate_scope? = Keyword.get(opts, :validate_scope?, true)

    with {:ok, explicit_thread_root_id} <-
           parse_optional_message_id(params, "thread_root_message_id"),
         {:ok, explicit_reply_to_id} <- parse_optional_message_id(params, "reply_to_message_id"),
         {:ok, legacy_parent_id} <- parse_optional_message_id(params, "parent_message_id"),
         {:ok, explicit_thread_root} <-
           resolve_optional_message(
             explicit_thread_root_id,
             scope_field,
             scope_id,
             validate_scope?
           ),
         {:ok, explicit_reply_to} <-
           resolve_optional_message(explicit_reply_to_id, scope_field, scope_id, validate_scope?),
         {:ok, legacy_parent} <-
           resolve_optional_message(legacy_parent_id, scope_field, scope_id, validate_scope?) do
      thread_root =
        explicit_thread_root ||
          derive_legacy_thread_root(legacy_parent, params["is_reply"] == true)

      reply_to =
        explicit_reply_to ||
          derive_legacy_reply_target(legacy_parent, params["is_reply"] == true)

      with :ok <- validate_thread_root(thread_root),
           :ok <- validate_reply_target(reply_to),
           :ok <- validate_thread_reply_compatibility(thread_root, reply_to) do
        {:ok,
         %{
           thread_root_message_id: thread_root && thread_root.id,
           reply_to_message_id: reply_to && reply_to.id,
           parent_message_id:
             cond do
               thread_root -> thread_root.id
               reply_to -> reply_to.id
               true -> nil
             end,
           is_reply: is_nil(thread_root) and not is_nil(reply_to)
         }}
      end
    end
  end

  def maybe_link_attachments(message, %{"attachment_ids" => ids})
      when is_list(ids) and ids != [] do
    Chat.link_attachments_to_message(ids, message.id)
    Vesper.Repo.preload(message, :attachments, force: true)
  end

  def maybe_link_attachments(message, _params), do: message

  def encrypted_message_payload(message, id_field, extra \\ %{}) do
    payload = %{
      id: message.id,
      room_seq: message.room_seq,
      ciphertext: Base.encode64(message.ciphertext),
      mls_epoch: message.mls_epoch,
      encryption_scheme: message.encryption_scheme,
      encryption_group_id: message.encryption_group_id,
      client_nonce: message.client_nonce,
      history_signing_public_key:
        if(is_binary(message.history_signing_public_key),
          do: Base.encode64(message.history_signing_public_key),
          else: nil
        ),
      history_revision: message.history_revision,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      thread_root_message_id: message.thread_root_message_id,
      reply_to_message_id: message.reply_to_message_id,
      is_reply: message.is_reply,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message),
      reactions: reactions_json(message)
    }

    payload
    |> Map.put(id_field, Map.get(message, id_field))
    |> Map.merge(extra)
  end

  def activity_message_json(nil), do: nil

  def activity_message_json(message) do
    base = %{
      id: message.id,
      room_seq: message.room_seq,
      client_nonce: message.client_nonce,
      inserted_at: message.inserted_at,
      sender_id: message.sender_id,
      sender: sender_json(message.sender)
    }

    if message.ciphertext do
      Map.put(base, :ciphertext, "encrypted")
    else
      Map.put(base, :content, message.content)
    end
  end

  def handle_edit_message(
        id,
        ciphertext_b64,
        epoch,
        encryption_scheme,
        encryption_group_id,
        history_signing_public_key_b64,
        history_revision,
        socket
      ) do
    with {:ok, ciphertext} <- safe_decode64(ciphertext_b64),
         %{} = message <- Chat.get_message(id),
         true <- message.sender_id == socket.assigns.user_id,
         {:ok, history_signing_public_key} <-
           decode_history_signing_key(%{
             "history_signing_public_key" => history_signing_public_key_b64
           }),
         {:ok, history_signing_public_key, history_revision} <-
           resolve_edit_history_auth(
             message,
             history_signing_public_key,
             history_revision
           ),
         %{} = room <- room_for_message(message),
         :ok <-
           Encryption.validate_application_scheme(
             room.id,
             encryption_scheme,
             epoch,
             encryption_group_id
           ) do
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      case Chat.update_message_revision(id, socket.assigns.user_id, history_revision, %{
             ciphertext: ciphertext,
             mls_epoch: epoch,
             encryption_scheme: encryption_scheme,
             encryption_group_id: encryption_group_id,
             history_signing_public_key: history_signing_public_key,
             edited_at: now
           }) do
        {:ok, _updated} ->
          payload =
            %{
              message_id: id,
              ciphertext: ciphertext_b64,
              mls_epoch: epoch,
              encryption_scheme: encryption_scheme,
              encryption_group_id: encryption_group_id,
              history_signing_public_key:
                if(is_binary(history_signing_public_key),
                  do: Base.encode64(history_signing_public_key),
                  else: nil
                ),
              history_revision: history_revision,
              edited_at: now
            }
            |> maybe_put(:channel_id, Map.get(socket.assigns, :channel_id))
            |> maybe_put(:conversation_id, Map.get(socket.assigns, :conversation_id))

          {:ok, payload}

        {:error, :stale_history_revision} ->
          {:error, "stale message revision"}

        {:error, _} ->
          {:error, "could not edit message"}
      end
    else
      {:error, :stale_history_revision} -> {:error, "stale message revision"}
      {:error, :invalid_history_revision} -> {:error, "invalid message revision"}
      {:error, _} -> {:error, "invalid encoding"}
      nil -> {:error, "message not found"}
      false -> {:error, "not the message author"}
    end
  end

  defp resolve_edit_history_auth(
         %{history_signing_public_key: nil} = message,
         nil,
         nil
       ),
       do: {:ok, nil, message.history_revision + 1}

  defp resolve_edit_history_auth(message, key, revision)
       when is_binary(key) and is_integer(revision) do
    if revision == message.history_revision + 1 do
      {:ok, key, revision}
    else
      {:error, :stale_history_revision}
    end
  end

  defp resolve_edit_history_auth(_message, _key, _revision),
    do: {:error, :invalid_history_revision}

  def handle_delete_message(id, user_id) do
    case Chat.get_message(id) do
      nil ->
        {:error, "message not found"}

      message ->
        if message.sender_id != user_id do
          {:error, "not the message author"}
        else
          case Chat.delete_message(message) do
            {:ok, _} -> {:ok, message}
            {:error, _} -> {:error, "could not delete message"}
          end
        end
    end
  end

  # Plaintext reaction (no encryption metadata)
  def handle_reaction(
        action,
        message_id,
        emoji,
        sender_id,
        expected_scope_field,
        expected_scope_value
      ) do
    handle_reaction(
      action,
      message_id,
      emoji,
      sender_id,
      expected_scope_field,
      expected_scope_value,
      %{}
    )
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
                |> maybe_put(:encryption_scheme, Map.get(crypto_meta, :encryption_scheme))
                |> maybe_put(:encryption_group_id, Map.get(crypto_meta, :encryption_group_id))

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

  defp room_for_message(%{channel_id: channel_id}) when is_binary(channel_id),
    do: Runtime.get_room_for_channel(channel_id)

  defp room_for_message(%{conversation_id: conversation_id}) when is_binary(conversation_id),
    do: Runtime.get_room_for_conversation(conversation_id)

  defp room_for_message(_message), do: nil

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

  defp parse_optional_message_id(params, key) do
    case Map.get(params, key) do
      nil -> {:ok, nil}
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, "#{key} must be a string"}
    end
  end

  defp resolve_optional_message(nil, _scope_field, _scope_id, _validate_scope?), do: {:ok, nil}

  defp resolve_optional_message(message_id, _scope_field, _scope_id, false)
       when is_binary(message_id) do
    case Chat.get_message(message_id) do
      nil -> {:error, "message not found"}
      message -> {:ok, message}
    end
  end

  defp resolve_optional_message(message_id, scope_field, scope_id, true)
       when is_binary(message_id) do
    case Chat.get_message(message_id) do
      nil ->
        {:error, "message not found"}

      message ->
        if scope_matches?(message, scope_field, scope_id) do
          {:ok, message}
        else
          {:error, "message is not in this scope"}
        end
    end
  end

  defp derive_legacy_thread_root(nil, _is_reply), do: nil
  defp derive_legacy_thread_root(_message, true), do: nil

  defp derive_legacy_thread_root(message, false) do
    effective_thread_root_message(message)
  end

  defp derive_legacy_reply_target(nil, _is_reply), do: nil
  defp derive_legacy_reply_target(_message, false), do: nil
  defp derive_legacy_reply_target(message, true), do: message

  defp validate_thread_root(nil), do: :ok

  defp validate_thread_root(message) do
    if effective_thread_root_id(message) do
      {:error, "thread root must be a top-level message"}
    else
      :ok
    end
  end

  defp validate_reply_target(nil), do: :ok
  defp validate_reply_target(_message), do: :ok

  defp validate_thread_reply_compatibility(nil, nil), do: :ok

  defp validate_thread_reply_compatibility(nil, reply_to) do
    case effective_thread_root_id(reply_to) do
      nil ->
        :ok

      root_id ->
        {:error, "reply target belongs to a thread; set thread_root_message_id to #{root_id}"}
    end
  end

  defp validate_thread_reply_compatibility(thread_root, nil) when not is_nil(thread_root), do: :ok

  defp validate_thread_reply_compatibility(thread_root, reply_to) do
    reply_thread_root_id = effective_thread_root_id(reply_to)

    cond do
      reply_to.id == thread_root.id ->
        :ok

      reply_thread_root_id == thread_root.id ->
        :ok

      true ->
        {:error, "reply target is not in the selected thread"}
    end
  end

  defp effective_thread_root_message(message) do
    cond do
      is_binary(message.thread_root_message_id) ->
        Chat.get_message(message.thread_root_message_id) || message

      is_binary(message.parent_message_id) and message.is_reply != true ->
        Chat.get_message(message.parent_message_id) || message

      true ->
        nil
    end
  end

  defp effective_thread_root_id(message) do
    case effective_thread_root_message(message) do
      nil -> nil
      root -> root.id
    end
  end

  defp scope_matches?(message, :channel_id, scope_id) do
    message.channel_id == scope_id and is_nil(message.conversation_id)
  end

  defp scope_matches?(message, :conversation_id, scope_id) do
    message.conversation_id == scope_id and is_nil(message.channel_id)
  end

  def maybe_add_expires_at(attrs, ttl) when is_integer(ttl) and ttl > 0 do
    expires_at =
      DateTime.utc_now()
      |> DateTime.add(ttl, :second)
      |> DateTime.truncate(:second)

    Map.put(attrs, :expires_at, expires_at)
  end

  def maybe_add_expires_at(attrs, _ttl), do: attrs
end
