defmodule VesperWeb.SponsoredTransitionController do
  @moduledoc """
  Atomically stores sponsored MLS transitions so the server never advertises or
  delivers a membership change that the sponsor failed to persist locally.
  """
  use VesperWeb, :controller

  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  @doc "POST /api/v1/mls-sponsored-transition/:scope_id"
  def create(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    with {:ok, authorization} <- ControllerHelpers.authorize_mls_scope(user.id, scope_id),
         authorized_group_id = authorization.group_id,
         {:ok, group_info_data} <- decode_required_base64(params, "group_info_data"),
         {:ok, ratchet_tree_data} <- decode_optional_base64(params, "ratchet_tree_data"),
         {:ok, previous_transcript_hash} <-
           decode_required_base64(params, "previous_transcript_hash"),
         epoch when is_integer(epoch) <- parse_epoch(params),
         previous_epoch when is_integer(previous_epoch) <- parse_previous_epoch(params),
         {:ok, recipient_id} <-
           require_non_empty_string(params, "recipient_id", :invalid_recipient),
         {:ok, commit_data} <-
           require_non_empty_string(params, "commit_data", :invalid_commit_data),
         {:ok, commit_id} <-
           require_non_empty_string(params, "commit_id", :invalid_idempotency_key),
         {:ok, remove_commit_data} <- optional_non_empty_string(params, "remove_commit_data"),
         {:ok, welcome_data} <- decode_optional_base64(params, "welcome_data") do
      channel_id = authorization.channel_id
      conversation_id = authorization.conversation_id

      attrs = %{
        group_id: authorized_group_id,
        group_info_data: group_info_data,
        ratchet_tree_data: ratchet_tree_data,
        epoch: epoch,
        previous_epoch: previous_epoch,
        previous_transcript_hash: previous_transcript_hash,
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
          json(conn, %{
            ok: true,
            fresh: transition.fresh,
            epoch: transition.group_info.epoch,
            transcript_hash: Base.encode64(Encryption.mls_transcript_hash(transition.group_info)),
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
          transition_conflict(conn, authorized_group_id)

        {:error, :invalid_previous_transcript_hash} ->
          conn |> put_status(:bad_request) |> json(%{error: "invalid previous_transcript_hash"})

        {:error, :invalid_epoch_transition} ->
          conn |> put_status(:conflict) |> json(%{error: "invalid_epoch_transition"})

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

  defp transition_conflict(conn, group_id) do
    case Encryption.get_group_info(group_id) do
      nil ->
        conn |> put_status(:conflict) |> json(%{error: "epoch_conflict", current_epoch: nil})

      group_info ->
        conn
        |> put_status(:conflict)
        |> json(%{
          error: "epoch_conflict",
          current_epoch: group_info.epoch,
          current_transcript_hash: Base.encode64(Encryption.mls_transcript_hash(group_info))
        })
    end
  end

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
end
