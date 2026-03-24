defmodule VesperWeb.SponsoredTransitionController do
  @moduledoc """
  Atomically stores sponsored MLS transitions so the server never advertises or
  delivers a membership change that the sponsor failed to persist locally.
  """
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Servers

  @doc "POST /api/v1/mls-sponsored-transition/:scope_id"
  def create(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    with {:ok, authorized_group_id} <- authorized_scope(user.id, scope_id),
         {:ok, group_info_data} <- decode_required_base64(params, "group_info_data"),
         {:ok, ratchet_tree_data} <- decode_optional_base64(params, "ratchet_tree_data"),
         epoch when is_integer(epoch) <- parse_epoch(params),
         previous_epoch when is_integer(previous_epoch) <- parse_previous_epoch(params),
         {:ok, recipient_id} <- require_non_empty_string(params, "recipient_id", :invalid_recipient),
         {:ok, commit_data} <- require_non_empty_string(params, "commit_data", :invalid_commit_data),
         {:ok, commit_id} <-
           require_non_empty_string(params, "commit_id", :invalid_idempotency_key),
         {:ok, remove_commit_data} <- optional_non_empty_string(params, "remove_commit_data"),
         {:ok, welcome_data} <- decode_optional_base64(params, "welcome_data") do
      {channel_id, conversation_id} = scope_ids(scope_id)

      attrs = %{
        group_id: authorized_group_id,
        group_info_data: group_info_data,
        ratchet_tree_data: ratchet_tree_data,
        epoch: epoch,
        previous_epoch: previous_epoch,
        publisher_id: user.id,
        publisher_client_id: device.client_id,
        recipient_id: recipient_id,
        recipient_client_id: optional_string(params, "recipient_device_id"),
        recipient_key_package_ref: optional_string(params, "recipient_key_package_ref"),
        remove_commit_data: remove_commit_data,
        commit_data: commit_data,
        commit_id: commit_id,
        welcome_data: welcome_data,
        sender_id: user.id,
        sender_device_id: device.client_id,
        channel_id: channel_id,
        conversation_id: conversation_id
      }

      case Encryption.publish_sponsored_transition(attrs) do
        {:ok, transition} ->
          if transition.fresh do
            broadcast_sponsored_transition(
              scope_id,
              transition,
              commit_data,
              Map.get(params, "welcome_data"),
              user.id,
              device.client_id
            )
          end

          json(conn, %{
            ok: true,
            fresh: transition.fresh,
            commit_event_seq: transition.commit_event.id,
            remove_event_seq: transition.remove_event && transition.remove_event.id,
            welcome_id: transition.welcome && transition.welcome.id
          })

        {:error, :invalid_transition_scope} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

        {:error, :invalid_recipient} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid recipient_id"})

        {:error, :invalid_commit_data} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid commit_data"})

        {:error, :invalid_group_info} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid group_info_data"})

        {:error, :invalid_previous_epoch} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid previous_epoch"})

        {:error, :invalid_remove_commit_data} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid remove_commit_data"})

        {:error, :invalid_welcome_data} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid welcome_data"})

        {:error, :invalid_idempotency_key} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid commit_id"})

        {:error, :idempotency_conflict} ->
          conn |> put_status(:conflict) |> json(%{error: "idempotency_conflict"})

        {:error, :epoch_conflict} ->
          conn |> put_status(:conflict) |> json(%{error: "epoch_conflict"})

        {:error, %Ecto.Changeset{} = changeset} ->
          conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(changeset.errors)})

        {:error, reason} ->
          conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(reason)})
      end
    else
      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})

      {:error, :missing_field, field} ->
        conn |> put_status(:bad_request) |> json(%{error: "missing #{field}"})

      {:error, :invalid_base64, field} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid base64 in #{field}"})

      {:error, :invalid_epoch} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid epoch"})

      {:error, :invalid_previous_epoch} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid previous_epoch"})

      {:error, reason} ->
        conn |> put_status(:bad_request) |> json(%{error: inspect(reason)})
    end
  end

  defp broadcast_sponsored_transition(
         scope_id,
         transition,
         commit_data,
         welcome_data,
         sender_id,
         sender_device_id
       ) do
    case scope_topic(scope_id) do
      nil ->
        :ok

      topic ->
        maybe_broadcast_remove(topic, transition.remove_event, sender_id, sender_device_id)

        VesperWeb.Endpoint.broadcast(topic, "mls_commit", %{
          seq: transition.commit_event.id,
          commit_data: commit_data,
          sender_id: sender_id,
          sender_device_id: sender_device_id
        })

        maybe_broadcast_welcome(
          topic,
          transition.welcome,
          welcome_data,
          sender_id
        )
    end
  end

  defp maybe_broadcast_remove(_topic, nil, _sender_id, _sender_device_id), do: :ok

  defp maybe_broadcast_remove(topic, remove_event, sender_id, sender_device_id) do
    payload = remove_event.payload || %{}

    VesperWeb.Endpoint.broadcast(
      topic,
      "mls_remove",
      %{
        seq: remove_event.id,
        removed_user_id: payload["removed_user_id"],
        commit_data: payload["commit_data"],
        sender_id: sender_id,
        sender_device_id: sender_device_id
      }
      |> maybe_put(:removed_device_id, payload["removed_device_id"])
    )
  end

  defp maybe_broadcast_welcome(_topic, nil, _welcome_data, _sender_id), do: :ok
  defp maybe_broadcast_welcome(_topic, _welcome, nil, _sender_id), do: :ok

  defp maybe_broadcast_welcome(topic, welcome, welcome_data, sender_id) do
    VesperWeb.Endpoint.broadcast(topic, "mls_welcome", %{
      id: welcome.id,
      recipient_id: welcome.recipient_id,
      recipient_device_id: welcome.recipient_client_id,
      key_package_ref: welcome.recipient_key_package_ref,
      welcome_data: welcome_data,
      sender_id: sender_id
    })
  end

  defp maybe_put(payload, _key, nil), do: payload
  defp maybe_put(payload, key, value), do: Map.put(payload, key, value)

  defp require_non_empty_string(params, field, invalid_reason) do
    case Map.get(params, field) do
      value when is_binary(value) and value != "" -> {:ok, value}
      nil -> {:error, :missing_field, field}
      _ -> {:error, invalid_reason}
    end
  end

  defp optional_non_empty_string(params, field) do
    case Map.get(params, field) do
      nil -> {:ok, nil}
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :"invalid_#{field}"}
    end
  end

  defp optional_string(params, field) do
    case Map.get(params, field) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp decode_required_base64(params, field) do
    case Map.get(params, field) do
      nil ->
        {:error, :missing_field, field}

      value when is_binary(value) ->
        case Base.decode64(value) do
          {:ok, data} -> {:ok, data}
          :error -> {:error, :invalid_base64, field}
        end

      _ ->
        {:error, :invalid_base64, field}
    end
  end

  defp decode_optional_base64(params, field) do
    case Map.get(params, field) do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        case Base.decode64(value) do
          {:ok, data} -> {:ok, data}
          :error -> {:error, :invalid_base64, field}
        end

      _ ->
        {:error, :invalid_base64, field}
    end
  end

  defp parse_epoch(params) do
    case Map.get(params, "epoch") do
      nil ->
        {:error, :invalid_epoch}

      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {parsed, ""} when parsed >= 0 -> parsed
          _ -> {:error, :invalid_epoch}
        end

      _ ->
        {:error, :invalid_epoch}
    end
  end

  defp parse_previous_epoch(params) do
    case Map.get(params, "previous_epoch") do
      nil ->
        {:error, :invalid_previous_epoch}

      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {parsed, ""} when parsed >= 0 -> parsed
          _ -> {:error, :invalid_previous_epoch}
        end

      _ ->
        {:error, :invalid_previous_epoch}
    end
  end

  defp scope_topic("voice:channel:" <> channel_id), do: "voice:channel:#{channel_id}"
  defp scope_topic("voice:dm:" <> conversation_id), do: "voice:dm:#{conversation_id}"

  defp scope_topic(scope_id) do
    case scope_ids(scope_id) do
      {channel_id, nil} when is_binary(channel_id) -> "chat:channel:#{channel_id}"
      {nil, conversation_id} when is_binary(conversation_id) -> "dm:#{conversation_id}"
      _ -> nil
    end
  end

  defp scope_ids(scope_id) do
    cond do
      String.starts_with?(scope_id, "voice:") ->
        {nil, nil}

      true ->
        case Ecto.UUID.cast(scope_id) do
          {:ok, uuid} ->
            cond do
              Servers.get_channel(uuid) != nil -> {uuid, nil}
              Chat.get_conversation(uuid) != nil -> {nil, uuid}
              true -> {nil, nil}
            end

          :error ->
            {nil, nil}
        end
    end
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
