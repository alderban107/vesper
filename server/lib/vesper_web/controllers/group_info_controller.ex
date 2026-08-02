defmodule VesperWeb.GroupInfoController do
  @moduledoc """
  Publishes and retrieves MLS GroupInfo for External Commit joins (RFC 9420 §12.4).

  After each epoch change, a group member publishes the new GroupInfo + ratchet tree.
  New members fetch it to self-join via External Commit — no existing member needs to be online.
  """
  use VesperWeb, :controller

  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  @doc "GET /api/v1/group-info/:scope_id — fetch latest GroupInfo for External Commit"
  def show(conn, %{"scope_id" => scope_id}) do
    user = conn.assigns.current_user

    case ControllerHelpers.authorize_mls_public_read(user.id, scope_id) do
      {:ok, %{group_id: authorized_group_id}} ->
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

    with {:ok, authorization} <- ControllerHelpers.authorize_mls_scope(user.id, scope_id),
         authorized_group_id = authorization.group_id,
         {:ok, group_info_data} <- decode_required_base64(params, "group_info_data"),
         {:ok, ratchet_tree_data} <- decode_optional_base64(params, "ratchet_tree_data"),
         epoch when is_integer(epoch) <- parse_epoch(params) do
      channel_id = authorization.channel_id
      conversation_id = authorization.conversation_id
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
                control_topic(authorization),
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

  defp broadcast_external_commit(topic, seq, commit_data, sender_id, sender_device_id) do
    VesperWeb.Endpoint.broadcast(topic, "mls_commit", %{
      seq: seq,
      commit_data: commit_data,
      sender_id: sender_id,
      sender_device_id: sender_device_id
    })
  end

  defp control_topic(%{cohort_id: cohort_id, group_id: group_id})
       when is_binary(cohort_id),
       do: "crypto:cohort:#{group_id}"

  defp control_topic(%{channel_id: channel_id}) when is_binary(channel_id),
    do: "chat:channel:#{channel_id}"

  defp control_topic(%{conversation_id: conversation_id}) when is_binary(conversation_id),
    do: "dm:#{conversation_id}"
end
