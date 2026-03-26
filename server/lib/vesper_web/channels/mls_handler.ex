defmodule VesperWeb.MlsHandler do
  @moduledoc """
  Shared MLS protocol handling for ChatChannel and DmChannel.

  Both channel types implement identical MLS lifecycle events (commit, remove,
  welcome, history request/bundle, eviction claim/skip, resync, request_join).
  This module extracts that shared logic, parameterized by scope.

  Callers pass a scope map: %{kind: "channel"|"dm", id: scope_id, id_key: :channel_id|:conversation_id}
  """

  alias Vesper.Encryption
  alias Vesper.Workers.ProcessPendingCryptoEvictions
  import VesperWeb.ChannelHelpers, only: [safe_decode64: 1]

  def handle_mls_request_join(payload, socket) do
    broadcast_from!(socket, "mls_request_join", %{
      user_id: socket.assigns.user_id,
      username: socket.assigns.username,
      device_id: Map.get(payload, "device_id") || socket.assigns.device_client_id
    })

    {:reply, :ok, socket}
  end

  def handle_mls_request_join_all(socket, scope) do
    case Encryption.store_mls_event(
           %{
             group_id: scope.id,
             event_type: "mls_request_join_all",
             payload: %{user_id: socket.assigns.user_id},
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> Map.put(scope.id_key, scope.id)
         ) do
      {:ok, event} ->
        broadcast_from!(socket, "mls_request_join_all", %{user_id: socket.assigns.user_id})
        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store join request"}}, socket}
    end
  end

  def handle_mls_resync_request(payload, socket, scope) do
    case normalize_resync_request(payload) do
      {:ok, attrs} ->
        case Encryption.store_pending_resync_request(
               %{
                 group_id: scope.id,
                 request_id: attrs.request_id,
                 requester_id: socket.assigns.user_id,
                 requester_username: socket.assigns.username,
                 requester_client_id:
                   Map.get(payload, "device_id") || socket.assigns.device_client_id,
                 last_known_epoch: attrs.last_known_epoch,
                 reason: attrs.reason
               }
               |> Map.put(scope.id_key, scope.id)
             ) do
          {:ok, request} ->
            broadcast_from!(socket, "mls_resync_request", %{
              id: request.id,
              user_id: socket.assigns.user_id,
              username: socket.assigns.username,
              device_id: request.requester_client_id,
              request_id: request.request_id,
              last_known_epoch: request.last_known_epoch,
              reason: request.reason
            })

            {:noreply, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not store resync request"}}, socket}
        end

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_mls_commit(%{"commit_data" => commit_data} = payload, socket, scope)
      when is_binary(commit_data) do
    idempotency_key =
      optional_binary(Map.get(payload, "idempotency_key")) ||
        optional_binary(Map.get(payload, "commit_id"))

    case Encryption.store_mls_commit_event(
           %{
             group_id: scope.id,
             event_type: "mls_commit",
             payload: %{commit_data: commit_data},
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> Map.put(scope.id_key, scope.id)
           |> maybe_put(:idempotency_key, idempotency_key)
         ) do
      {:ok, event} ->
        broadcast!(socket, "mls_commit", %{
          seq: event.id,
          commit_data: commit_data,
          sender_id: socket.assigns.user_id,
          sender_device_id: socket.assigns.device_client_id
        })

        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store commit"}}, socket}
    end
  end

  def handle_mls_eviction_claim(%{"id" => eviction_id}, socket, scope)
      when is_binary(eviction_id) do
    with :ok <- ensure_trusted_sponsor(socket),
         {:ok, _eviction} <-
           Encryption.claim_pending_crypto_eviction(
             eviction_id,
             scope.kind,
             scope.id,
             socket.assigns.user_id,
             socket.assigns.device_client_id
           ) do
      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}
    end
  end

  def handle_mls_eviction_skip(%{"id" => eviction_id} = payload, socket, scope)
      when is_binary(eviction_id) do
    target_user_id =
      Map.get(payload, "target_user_id") ||
        Map.get(payload, "removed_user_id") ||
        Map.get(payload, "user_id")

    target_device_id =
      optional_binary(
        Map.get(payload, "target_device_id") ||
          Map.get(payload, "removed_device_id") ||
          Map.get(payload, "device_id")
      )

    reason = optional_binary(Map.get(payload, "reason")) || "skipped"

    with :ok <- ensure_trusted_sponsor(socket),
         true <- is_binary(target_user_id),
         {:ok, _eviction} <-
           Encryption.skip_pending_crypto_eviction(
             eviction_id,
             scope.kind,
             scope.id,
             target_user_id,
             target_device_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id,
             reason
           ) do
      request_next_crypto_eviction(scope.kind, scope.id)
      {:reply, :ok, socket}
    else
      false ->
        {:reply, {:error, %{reason: "missing target_user_id"}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}
    end
  end

  def handle_mls_remove(
        %{"removed_user_id" => removed_user_id, "commit_data" => commit_data} = payload,
        socket,
        scope
      )
      when is_binary(removed_user_id) and is_binary(commit_data) do
    removed_device_id = optional_binary(Map.get(payload, "removed_device_id"))
    eviction_id = optional_binary(Map.get(payload, "eviction_id"))

    event_payload =
      %{
        removed_user_id: removed_user_id,
        commit_data: commit_data
      }
      |> maybe_put(:removed_device_id, removed_device_id)
      |> maybe_put(:eviction_id, eviction_id)

    crypto_eviction =
      if eviction_id do
        %{
          eviction_id: eviction_id,
          scope_kind: scope.kind,
          scope_id: scope.id,
          removed_user_id: removed_user_id,
          removed_device_id: removed_device_id,
          sponsor_user_id: socket.assigns.user_id,
          sponsor_device_id: socket.assigns.device_client_id
        }
      end

    case Encryption.store_mls_remove_event(
           %{
             group_id: scope.id,
             event_type: "mls_remove",
             payload: event_payload,
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> Map.put(scope.id_key, scope.id),
           crypto_eviction
         ) do
      {:ok, event} ->
        broadcast!(
          socket,
          "mls_remove",
          %{
            seq: event.id,
            removed_user_id: removed_user_id,
            commit_data: commit_data,
            sender_id: socket.assigns.user_id,
            sender_device_id: socket.assigns.device_client_id
          }
          |> maybe_put(:removed_device_id, removed_device_id)
          |> maybe_put(:eviction_id, eviction_id)
        )

        if eviction_id do
          request_next_crypto_eviction(scope.kind, scope.id)
        end

        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store remove"}}, socket}
    end
  end

  def handle_mls_welcome(
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data} = payload,
        socket,
        scope
      )
      when is_binary(recipient_id) and is_binary(welcome_data) do
    case safe_decode64(welcome_data) do
      {:ok, decoded} ->
        sender_id = socket.assigns.user_id

        case Encryption.store_pending_welcome(
               %{
                 recipient_id: recipient_id,
                 recipient_client_id: Map.get(payload, "recipient_device_id"),
                 recipient_key_package_ref: Map.get(payload, "key_package_ref"),
                 group_id: scope.id,
                 welcome_data: decoded,
                 sender_id: sender_id
               }
               |> Map.put(scope.id_key, scope.id)
             ) do
          {:ok, welcome} ->
            broadcast!(socket, "mls_welcome", %{
              id: welcome.id,
              recipient_id: recipient_id,
              recipient_device_id: welcome.recipient_client_id,
              key_package_ref: welcome.recipient_key_package_ref,
              welcome_data: welcome_data,
              sender_id: sender_id
            })

            {:reply, {:ok, %{id: welcome.id}}, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not store welcome"}}, socket}
        end

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  def handle_mls_history_request(payload, socket, scope, notify_fn) do
    requester_device_id =
      case Map.get(payload, "device_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    case Encryption.store_pending_history_request(
           %{
             group_id: scope.id,
             requester_id: socket.assigns.user_id,
             requester_username: socket.assigns.username,
             requester_client_id: requester_device_id
           }
           |> Map.put(scope.id_key, scope.id)
         ) do
      {:ok, request} ->
        broadcast_from!(socket, "mls_history_request", %{
          id: request.id,
          user_id: socket.assigns.user_id,
          device_id: requester_device_id
        })

        notify_fn.()

        {:noreply, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store history request"}}, socket}
    end
  end

  def handle_mls_history_bundle(
        %{
          "ciphertext" => ciphertext,
          "mls_epoch" => epoch,
          "recipient_id" => recipient_id
        } = payload,
        socket,
        scope
      ) do
    recipient_device_id =
      case Map.get(payload, "recipient_device_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    case Encryption.store_pending_history_bundle(
           %{
             group_id: scope.id,
             ciphertext: ciphertext,
             mls_epoch: epoch,
             recipient_id: recipient_id,
             recipient_client_id: recipient_device_id,
             sender_id: socket.assigns.user_id
           }
           |> Map.put(scope.id_key, scope.id)
         ) do
      {:ok, bundle} ->
        broadcast!(socket, "mls_history_bundle", %{
          id: bundle.id,
          ciphertext: ciphertext,
          mls_epoch: epoch,
          recipient_id: recipient_id,
          recipient_device_id: recipient_device_id,
          sender_id: socket.assigns.user_id
        })

        topic =
          case scope.id_key do
            :channel_id -> "chat:channel:#{scope.id}"
            :conversation_id -> "dm:#{scope.id}"
          end

        VesperWeb.Endpoint.broadcast("user:#{recipient_id}", "mls_history_bundle_pending", %{
          scope_id: scope.id,
          topic: topic
        })

        {:reply, :ok, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store history bundle"}}, socket}
    end
  end

  def replay_mls_join_broadcasts(socket, scope_id) do
    user_id = socket.assigns.user_id

    Encryption.list_recent_mls_events(scope_id, 50, "mls_request_join_all")
    |> Enum.filter(fn event -> event.sender_id != user_id end)
    |> Enum.uniq_by(& &1.sender_id)
    |> Enum.each(fn event ->
      Phoenix.Channel.push(socket, "mls_request_join_all", %{
        user_id: event.sender_id
      })
    end)
  end

  # --- Shared helpers ---

  def normalize_resync_request(payload) do
    request_id = Map.get(payload, "request_id")
    last_known_epoch = Map.get(payload, "last_known_epoch")
    reason = Map.get(payload, "reason")

    cond do
      not is_binary(request_id) ->
        {:error, "missing request_id"}

      not (is_nil(last_known_epoch) or is_integer(last_known_epoch)) ->
        {:error, "invalid last_known_epoch"}

      not (is_nil(reason) or is_binary(reason)) ->
        {:error, "invalid reason"}

      true ->
        {:ok,
         %{
           request_id: request_id,
           last_known_epoch: last_known_epoch,
           reason: reason
         }}
    end
  end

  def ensure_trusted_sponsor(socket) do
    if socket.assigns.device_trust_state == "trusted" do
      :ok
    else
      {:error, :trusted_device_required}
    end
  end

  def optional_binary(value) when is_binary(value) and value != "", do: value
  def optional_binary(_value), do: nil

  def maybe_put(map, _key, nil), do: map
  def maybe_put(map, key, value), do: Map.put(map, key, value)

  def eviction_error_reason(:trusted_device_required), do: "trusted device required"
  def eviction_error_reason(:not_found), do: "eviction not found"
  def eviction_error_reason(:not_claimable), do: "eviction not claimable"
  def eviction_error_reason(:target_cannot_sponsor), do: "target cannot sponsor eviction"
  def eviction_error_reason(:target_mismatch), do: "eviction target mismatch"
  def eviction_error_reason(:target_device_mismatch), do: "eviction target device mismatch"
  def eviction_error_reason(:sponsor_mismatch), do: "eviction sponsor mismatch"
  def eviction_error_reason(reason) when is_binary(reason), do: reason
  def eviction_error_reason(reason), do: inspect(reason)

  defp request_next_crypto_eviction(scope_kind, scope_id) do
    ProcessPendingCryptoEvictions.request_scope(scope_kind, scope_id)
  end

  # Phoenix.Channel functions needed for broadcast
  defp broadcast!(socket, event, payload) do
    Phoenix.Channel.broadcast!(socket, event, payload)
  end

  defp broadcast_from!(socket, event, payload) do
    Phoenix.Channel.broadcast_from!(socket, event, payload)
  end
end
