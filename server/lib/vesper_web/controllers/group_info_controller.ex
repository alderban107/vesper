defmodule VesperWeb.GroupInfoController do
  @moduledoc """
  Publishes and retrieves MLS GroupInfo for External Commit joins (RFC 9420 §12.4).

  After each epoch change, a group member publishes the new GroupInfo + ratchet tree.
  New members fetch it to self-join via External Commit — no existing member needs to be online.
  """
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Servers

  @doc "GET /api/v1/group-info/:scope_id — fetch latest GroupInfo for External Commit"
  def show(conn, %{"scope_id" => scope_id}) do
    user = conn.assigns.current_user

    case authorized_scope(user.id, scope_id) do
      {:ok, authorized_group_id} ->
        case Encryption.get_group_info(authorized_group_id) do
          nil ->
            conn |> put_status(:not_found) |> json(%{error: "no group info published"})

          group_info ->
            json(conn, %{
              group_info: %{
                group_id: group_info.group_id,
                group_info_data: Base.encode64(group_info.group_info_data),
                ratchet_tree_data:
                  if(group_info.ratchet_tree_data,
                    do: Base.encode64(group_info.ratchet_tree_data),
                    else: nil
                  ),
                epoch: group_info.epoch,
                publisher_id: group_info.publisher_id,
                updated_at: group_info.updated_at
              }
            })
        end

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  @doc "PUT /api/v1/group-info/:scope_id — publish GroupInfo after an epoch change"
  def upsert(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    with {:ok, authorized_group_id} <- authorized_scope(user.id, scope_id),
         {:ok, group_info_data} <- decode_required_base64(params, "group_info_data"),
         {:ok, ratchet_tree_data} <- decode_optional_base64(params, "ratchet_tree_data"),
         epoch when is_integer(epoch) <- parse_epoch(params) do
      {channel_id, conversation_id} = scope_ids(scope_id)
      previous_epoch = parse_optional_epoch(params, "previous_epoch")
      commit_data = external_commit_data(params)
      commit_id = external_commit_id(params)

      attrs = %{
        group_id: authorized_group_id,
        group_info_data: group_info_data,
        ratchet_tree_data: ratchet_tree_data,
        epoch: epoch,
        previous_epoch: previous_epoch,
        publisher_id: user.id,
        publisher_client_id: device.client_id,
        channel_id: channel_id,
        conversation_id: conversation_id
      }

      case {commit_data, commit_id} do
        {nil, nil} ->
          case Encryption.publish_group_info(attrs) do
            {:ok, group_info} ->
              json(conn, %{
                group_info: %{
                  group_id: group_info.group_id,
                  epoch: group_info.epoch,
                  updated_at: group_info.updated_at
                }
              })

            {:error, :epoch_conflict} ->
              conn |> put_status(:conflict) |> json(%{error: "epoch_conflict"})

            {:error, reason} ->
              conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(reason)})
          end

        {commit_data, commit_id} when is_binary(commit_data) and is_binary(commit_id) ->
          case Encryption.publish_external_commit_group_info(
                 Map.merge(attrs, %{
                   commit_data: commit_data,
                   commit_id: commit_id
                 })
               ) do
            {:ok, %{group_info: group_info, event: event}} ->
              broadcast_external_commit(
                scope_id,
                event.id,
                commit_data,
                user.id,
                device.client_id
              )

              json(conn, %{
                group_info: %{
                  group_id: group_info.group_id,
                  epoch: group_info.epoch,
                  updated_at: group_info.updated_at
                },
                commit_event_seq: event.id
              })

            {:error, :epoch_conflict} ->
              conn |> put_status(:conflict) |> json(%{error: "epoch_conflict"})

            {:error, :invalid_previous_epoch} ->
              conn |> put_status(:bad_request) |> json(%{error: "invalid previous_epoch"})

            {:error, :invalid_commit_data} ->
              conn |> put_status(:bad_request) |> json(%{error: "invalid commit_data"})

            {:error, :invalid_idempotency_key} ->
              conn |> put_status(:bad_request) |> json(%{error: "invalid commit_id"})

            {:error, reason} ->
              conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(reason)})
          end

        _ ->
          conn
          |> put_status(:bad_request)
          |> json(%{error: "commit_data and commit_id must be provided together"})
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
    end
  end

  # --- Helpers ---

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
        {:error, :missing_field, field}
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
        {:ok, nil}
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

  defp parse_optional_epoch(params, field) do
    case Map.get(params, field) do
      nil ->
        nil

      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {parsed, ""} when parsed >= 0 -> parsed
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp external_commit_data(params) do
    case Map.get(params, "commit_data") do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp external_commit_id(params) do
    case Map.get(params, "commit_id") || Map.get(params, "idempotency_key") do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp broadcast_external_commit(scope_id, seq, commit_data, sender_id, sender_device_id) do
    case scope_topic(scope_id) do
      nil ->
        :ok

      topic ->
        VesperWeb.Endpoint.broadcast(topic, "mls_commit", %{
          seq: seq,
          commit_data: commit_data,
          sender_id: sender_id,
          sender_device_id: sender_device_id
        })
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
            # Could be channel or conversation — check which exists.
            # For the upsert, we just try channel first.
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

  # --- Scope authorization (same pattern as other MLS controllers) ---

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
