defmodule VesperWeb.RoomKeyEpochController do
  use VesperWeb, :controller

  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  def material(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user
    topology_id = params["topology_id"]

    with {:ok, room} <- ControllerHelpers.authorize_room_scope(user.id, scope_id),
         {:ok, topology, cohorts} <-
           Encryption.get_room_key_coordination_material(room.id, topology_id) do
      json(conn, %{
        topology: %{room_id: room.id, generation: topology.generation},
        cohorts: Enum.map(cohorts, &render_cohort/1)
      })
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def active(conn, %{"scope_id" => scope_id}) do
    user = conn.assigns.current_user

    with {:ok, room} <- ControllerHelpers.authorize_room_scope(user.id, scope_id),
         {:ok, topology} <- Encryption.resolve_room_topology(room.id, user.id) do
      case Encryption.get_active_room_key_epoch(room.id) do
        nil -> conn |> put_status(:not_found) |> json(%{error: "no active room key"})
        epoch -> json(conn, %{room_key_epoch: render_epoch(epoch, topology.cohort_id)})
      end
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def prepare(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    with {:ok, room} <- ControllerHelpers.authorize_room_scope(user.id, scope_id),
         request_id when is_binary(request_id) and byte_size(request_id) in 8..128 <-
           params["request_id"],
         reason
         when reason in [
                "initial",
                "membership_change",
                "topology_change",
                "wrapping_key_rotation",
                "repair",
                "policy"
              ] <- params["reason"],
         {:ok, epoch} <-
           Encryption.prepare_room_key_epoch(
             room.id,
             user.id,
             device.client_id,
             request_id,
             reason,
             params["topology_id"]
           ),
         {:ok, topology, cohorts} <-
           Encryption.get_room_key_coordination_material(room.id, params["topology_id"]) do
      json(conn, %{
        room_key_epoch: render_epoch(epoch),
        topology: %{room_id: room.id, generation: topology.generation},
        cohorts: Enum.map(cohorts, &render_cohort/1)
      })
    else
      value when is_binary(value) or is_nil(value) ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid room-key request"})

      {:error, reason} ->
        render_error(conn, reason)
    end
  end

  def claim(conn, %{"epoch_id" => epoch_id}) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, claimed} <-
           Encryption.claim_room_key_epoch(
             epoch.id,
             conn.assigns.current_user.id,
             conn.assigns.current_device.client_id
           ) do
      json(conn, %{room_key_epoch: render_epoch(claimed)})
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def renew(conn, %{"epoch_id" => epoch_id, "fencing_token" => fencing_token})
      when is_integer(fencing_token) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, renewed} <-
           Encryption.renew_room_key_epoch(
             epoch.id,
             conn.assigns.current_user.id,
             conn.assigns.current_device.client_id,
             fencing_token
           ) do
      json(conn, %{room_key_epoch: render_epoch(renewed)})
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def renew(conn, _params), do: render_error(conn, :invalid_envelope)

  def put_envelope(
        conn,
        %{"epoch_id" => epoch_id, "cohort_id" => cohort_id, "fencing_token" => fencing_token} =
          params
      )
      when is_integer(fencing_token) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, attrs} <- decode_envelope(params),
         {:ok, envelope} <-
           Encryption.put_room_key_envelope(
             epoch.id,
             cohort_id,
             conn.assigns.current_user.id,
             conn.assigns.current_device.client_id,
             fencing_token,
             attrs
           ) do
      json(conn, %{envelope: render_envelope(envelope)})
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def put_envelope(conn, _params), do: render_error(conn, :invalid_envelope)

  def activate(conn, %{"epoch_id" => epoch_id, "fencing_token" => fencing_token})
      when is_integer(fencing_token) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, active} <-
           Encryption.activate_room_key_epoch(
             epoch.id,
             conn.assigns.current_user.id,
             conn.assigns.current_device.client_id,
             fencing_token
           ) do
      json(conn, %{room_key_epoch: render_epoch(active)})
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def activate(conn, _params), do: render_error(conn, :invalid_envelope)

  def stage(conn, %{"epoch_id" => epoch_id, "fencing_token" => fencing_token})
      when is_integer(fencing_token) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, staged} <-
           Encryption.stage_room_key_epoch(
             epoch.id,
             conn.assigns.current_user.id,
             conn.assigns.current_device.client_id,
             fencing_token
           ),
         {:ok, _topology} <- Encryption.mark_room_topology_key_ready(epoch.topology_id, epoch.id) do
      json(conn, %{room_key_epoch: render_epoch(staged)})
    else
      {:error, reason} -> render_error(conn, reason)
    end
  end

  def stage(conn, _params), do: render_error(conn, :invalid_envelope)

  def repair(conn, %{"epoch_id" => epoch_id, "reason" => reason}) when is_binary(reason) do
    with {:ok, epoch} <- authorize_epoch(conn, epoch_id),
         {:ok, repairing} <- Encryption.report_room_key_epoch_repair(epoch.id, reason) do
      json(conn, %{room_key_epoch: render_epoch(repairing)})
    else
      {:error, error} -> render_error(conn, error)
    end
  end

  def repair(conn, _params), do: render_error(conn, :invalid_envelope)

  defp authorize_epoch(conn, epoch_id) do
    case Encryption.get_room_key_epoch(epoch_id) do
      nil ->
        {:error, :not_found}

      epoch ->
        scope_id = epoch.room.channel_id || epoch.room.conversation_id

        with {:ok, _room} <-
               ControllerHelpers.authorize_room_scope(conn.assigns.current_user.id, scope_id) do
          {:ok, epoch}
        end
    end
  end

  defp decode_envelope(params) do
    with group_id when is_binary(group_id) and byte_size(group_id) > 0 <- params["group_id"],
         wrapping_epoch when is_integer(wrapping_epoch) and wrapping_epoch >= 0 <-
           params["wrapping_mls_epoch"],
         {:ok, ephemeral_public_key} <- decode(params["ephemeral_public_key"], 32),
         {:ok, nonce} <- decode(params["nonce"], 12),
         {:ok, ciphertext} <- decode(params["ciphertext"], 48),
         {:ok, aad_digest} <- decode(params["aad_digest"], 32) do
      {:ok,
       %{
         group_id: group_id,
         wrapping_mls_epoch: wrapping_epoch,
         ephemeral_public_key: ephemeral_public_key,
         nonce: nonce,
         ciphertext: ciphertext,
         aad_digest: aad_digest
       }}
    else
      _ -> {:error, :invalid_envelope}
    end
  end

  defp decode(value, size) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} when byte_size(decoded) == size -> {:ok, decoded}
      _ -> {:error, :invalid_envelope}
    end
  end

  defp decode(_, _), do: {:error, :invalid_envelope}

  defp render_cohort(%{cohort: cohort, wrapping_key: wrapping_key}) do
    %{
      cohort_id: cohort.id,
      group_id: cohort.group_id,
      ordinal: cohort.ordinal,
      wrapping_key: if(wrapping_key, do: render_wrapping_key(wrapping_key), else: nil)
    }
  end

  defp render_wrapping_key(key) do
    %{
      mls_epoch: key.mls_epoch,
      public_key: Base.encode64(key.public_key),
      signature: Base.encode64(key.signature),
      signer_identity: key.signer_identity,
      signer_public_key: Base.encode64(key.signer_public_key),
      group_info_digest: Base.encode64(key.group_info_digest)
    }
  end

  defp render_epoch(epoch), do: render_epoch(epoch, :all)

  defp render_epoch(epoch, cohort_id) do
    envelopes =
      if Ecto.assoc_loaded?(epoch.envelopes) do
        case cohort_id do
          :all -> epoch.envelopes
          nil -> []
          id -> Enum.filter(epoch.envelopes, &(&1.cohort_id == id))
        end
      else
        []
      end

    %{
      id: epoch.id,
      room_id: epoch.room_id,
      topology_generation: epoch.topology_generation,
      epoch: epoch.epoch,
      state: epoch.state,
      reason: epoch.reason,
      request_id: epoch.request_id,
      fencing_token: epoch.fencing_token,
      expected_cohort_count: epoch.expected_cohort_count,
      lease_expires_at: epoch.lease_expires_at,
      activated_at: epoch.activated_at,
      retained_until: epoch.retained_until,
      repair_reason: epoch.repair_reason,
      envelopes: Enum.map(envelopes, &render_envelope/1)
    }
  end

  defp render_envelope(envelope) do
    %{
      cohort_id: envelope.cohort_id,
      group_id: envelope.group_id,
      wrapping_mls_epoch: envelope.wrapping_mls_epoch,
      ephemeral_public_key: Base.encode64(envelope.ephemeral_public_key),
      nonce: Base.encode64(envelope.nonce),
      ciphertext: Base.encode64(envelope.ciphertext),
      aad_digest: Base.encode64(envelope.aad_digest)
    }
  end

  defp render_error(conn, reason)
       when reason in [
              :coordination_in_progress,
              :lease_held,
              :request_conflict,
              :epoch_conflict,
              :envelope_conflict
            ] do
    conn |> put_status(:conflict) |> json(%{error: to_string(reason)})
  end

  defp render_error(conn, reason)
       when reason in [
              :stale_fence,
              :lease_expired,
              :stale_wrapping_key,
              :topology_changed,
              :incomplete_envelopes
            ] do
    conn |> put_status(:conflict) |> json(%{error: to_string(reason)})
  end

  defp render_error(conn, reason)
       when reason in [
              :invalid_envelope,
              :invalid_cohort,
              :no_active_cohorts,
              :wrapping_keys_incomplete,
              :wrapping_key_missing,
              :multi_cohort_topology_required,
              :cohort_assignment_required,
              :epoch_not_open,
              :epoch_retired,
              :not_claimable
            ] do
    conn |> put_status(:unprocessable_entity) |> json(%{error: to_string(reason)})
  end

  defp render_error(conn, :invalid_scope),
    do: conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

  defp render_error(conn, :forbidden),
    do: conn |> put_status(:forbidden) |> json(%{error: "not a member"})

  defp render_error(conn, :not_found),
    do: conn |> put_status(:not_found) |> json(%{error: "not found"})

  defp render_error(conn, reason),
    do: conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(reason)})
end
