defmodule VesperWeb.MlsHandler do
  @moduledoc """
  Shared MLS protocol handling for ChatChannel and DmChannel.

  Both channel types implement identical MLS lifecycle events (commit, remove,
  welcome, history request/bundle, eviction claim/skip, resync, request_join).
  This module extracts that shared logic, parameterized by scope.

  Callers pass a scope map with separate protocol and authorization identities:
  `%{kind: "channel" | "dm", group_id: group_id, resource_id: room_scope_id,
  id_key: :channel_id | :conversation_id, topic: topic}`.
  """

  alias Vesper.Encryption
  alias Vesper.Workers.ProcessPendingCryptoEvictions
  alias VesperWeb.ControllerHelpers
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
             group_id: scope.group_id,
             event_type: "mls_request_join_all",
             payload: %{user_id: socket.assigns.user_id},
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> Map.put(scope.id_key, scope.resource_id)
         ) do
      {:ok, event} ->
        broadcast_from!(socket, "mls_request_join_all", %{user_id: socket.assigns.user_id})
        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store join request"}}, socket}
    end
  end

  def handle_mls_resync_request(payload, socket, scope) do
    with {:ok, attrs} <- normalize_resync_request(payload),
         {:ok, idempotency_key} <- require_idempotency_key(payload),
         requester_client_id =
           Map.get(payload, "device_id") || socket.assigns.device_client_id,
         control_payload = %{
           request_id: attrs.request_id,
           requester_client_id: requester_client_id,
           last_known_epoch: attrs.last_known_epoch,
           reason: attrs.reason,
           membership_generation: Map.get(payload, "membership_generation")
         },
         {:ok, result, status} <-
           run_control_operation(
             socket,
             scope,
             "mls_resync_request",
             idempotency_key,
             control_payload,
             fn ->
               with {:ok, request} <-
                      Encryption.store_pending_resync_request(
                        %{
                          group_id: scope.group_id,
                          request_id: attrs.request_id,
                          requester_id: socket.assigns.user_id,
                          requester_username: socket.assigns.username,
                          requester_client_id: requester_client_id,
                          last_known_epoch: attrs.last_known_epoch,
                          reason: attrs.reason
                        }
                        |> Map.put(scope.id_key, scope.resource_id)
                      ) do
                 {:ok,
                  %{
                    "id" => request.id,
                    "request_id" => request.request_id,
                    "requester_client_id" => request.requester_client_id,
                    "last_known_epoch" => request.last_known_epoch,
                    "reason" => request.reason
                  }}
               end
             end
           ) do
      if status == :new do
        broadcast_from!(socket, "mls_resync_request", %{
          id: result["id"],
          user_id: socket.assigns.user_id,
          username: socket.assigns.username,
          device_id: result["requester_client_id"],
          request_id: result["request_id"],
          last_known_epoch: result["last_known_epoch"],
          reason: result["reason"]
        })
      end

      {:reply, {:ok, %{id: result["id"]}}, socket}
    else
      {:error, reason} -> control_error_reply(reason, socket)
    end
  end

  def handle_mls_commit(%{"commit_data" => commit_data} = payload, socket, scope)
      when is_binary(commit_data) do
    idempotency_key =
      optional_binary(Map.get(payload, "idempotency_key")) ||
        optional_binary(Map.get(payload, "commit_id"))

    with {:ok, transition} <- normalize_transition_payload(payload),
         :ok <- authorize_mls_mutation(socket, scope),
         {:ok, idempotency_key} <- require_present_idempotency_key(idempotency_key),
         control_payload <- Map.merge(transition, %{commit_data: commit_data}),
         {:ok, result, _status} <-
           run_control_operation(
             socket,
             scope,
             "mls_commit",
             idempotency_key,
             control_payload,
             fn ->
               Encryption.publish_ordinary_transition(
                 %{
                   group_id: scope.group_id,
                   event_type: "mls_commit",
                   payload: %{commit_data: commit_data, transition_type: "ordinary"},
                   sender_id: socket.assigns.user_id,
                   sender_device_id: socket.assigns.device_client_id,
                   idempotency_key: idempotency_key
                 }
                 |> Map.put(scope.id_key, scope.resource_id)
                 |> Map.merge(transition)
               )
               |> case do
                 {:ok, %{event: event}} -> {:ok, %{"seq" => event.id}}
                 {:error, reason} -> {:error, reason}
               end
             end
           ) do
      {:reply, {:ok, %{seq: result["seq"]}}, socket}
    else
      {:error, :epoch_conflict} -> transition_conflict_reply(scope, socket)
      {:error, reason} -> control_error_reply(reason, socket)
    end
  end

  def handle_mls_eviction_claim(
        %{
          "id" => eviction_id,
          "fencing_token" => fencing_token,
          "membership_generation" => membership_generation
        },
        socket,
        scope
      )
      when is_binary(eviction_id) and is_integer(fencing_token) and
             is_integer(membership_generation) do
    with :ok <- ensure_trusted_sponsor(socket),
         {:ok, _eviction} <-
           Encryption.claim_pending_crypto_eviction(
             eviction_id,
             scope.kind,
             scope.group_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id,
             fencing_token,
             membership_generation
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
    fencing_token = Map.get(payload, "fencing_token")
    membership_generation = Map.get(payload, "membership_generation")

    with :ok <- ensure_trusted_sponsor(socket),
         true <- is_binary(target_user_id),
         true <- is_integer(fencing_token),
         true <- is_integer(membership_generation),
         {:ok, _eviction} <-
           Encryption.skip_pending_crypto_eviction(
             eviction_id,
             scope.kind,
             scope.group_id,
             target_user_id,
             target_device_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id,
             fencing_token,
             membership_generation,
             reason
           ) do
      request_next_crypto_eviction(scope.kind, scope.group_id)
      {:reply, :ok, socket}
    else
      false ->
        {:reply, {:error, %{reason: "missing eviction fencing metadata"}}, socket}

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
    fencing_token = Map.get(payload, "fencing_token")
    membership_generation = Map.get(payload, "membership_generation")
    resulting_generation = Map.get(payload, "resulting_generation")

    removals =
      case Map.get(payload, "evictions") do
        evictions when is_list(evictions) and evictions != [] ->
          evictions

        _ ->
          [
            %{
              "id" => eviction_id,
              "removed_user_id" => removed_user_id,
              "removed_device_id" => removed_device_id,
              "fencing_token" => fencing_token,
              "membership_generation" => membership_generation
            }
          ]
      end

    event_payload =
      %{
        removed_user_id: removed_user_id,
        commit_data: commit_data,
        removals: removals
      }
      |> maybe_put(:removed_device_id, removed_device_id)
      |> maybe_put(:eviction_id, eviction_id)
      |> maybe_put(:resulting_generation, resulting_generation)

    crypto_evictions =
      removals
      |> Enum.filter(&(is_binary(Map.get(&1, "id")) || is_binary(Map.get(&1, :id))))
      |> Enum.map(fn removal ->
        %{
          eviction_id: Map.get(removal, "id") || Map.get(removal, :id),
          scope_kind: scope.kind,
          scope_id: scope.group_id,
          removed_user_id:
            Map.get(removal, "removed_user_id") || Map.get(removal, :removed_user_id),
          removed_device_id:
            optional_binary(
              Map.get(removal, "removed_device_id") || Map.get(removal, :removed_device_id)
            ),
          sponsor_user_id: socket.assigns.user_id,
          sponsor_device_id: socket.assigns.device_client_id,
          fencing_token: Map.get(removal, "fencing_token") || Map.get(removal, :fencing_token),
          membership_generation:
            Map.get(removal, "membership_generation") ||
              Map.get(removal, :membership_generation)
        }
      end)

    with {:ok, transition} <- normalize_transition_payload(payload),
         :ok <- authorize_mls_mutation(socket, scope),
         true <-
           valid_removal_fences?(removals, crypto_evictions) || {:error, :eviction_fence_required},
         {:ok, idempotency_key} <- require_idempotency_key(payload),
         control_payload =
           event_payload
           |> Map.merge(transition)
           |> Map.put(:fencing_token, fencing_token)
           |> Map.put(:membership_generation, membership_generation)
           |> Map.put(:resulting_generation, Map.get(payload, "resulting_generation"))
           |> Map.put(:removals, removals),
         {:ok, result, status} <-
           run_control_operation(
             socket,
             scope,
             "mls_remove",
             idempotency_key,
             control_payload,
             fn ->
               Encryption.publish_ordinary_transition(
                 %{
                   group_id: scope.group_id,
                   event_type: "mls_remove",
                   payload: event_payload,
                   sender_id: socket.assigns.user_id,
                   sender_device_id: socket.assigns.device_client_id,
                   idempotency_key: idempotency_key,
                   crypto_evictions: crypto_evictions
                 }
                 |> Map.put(scope.id_key, scope.resource_id)
                 |> Map.merge(transition)
               )
               |> case do
                 {:ok, %{event: event}} -> {:ok, %{"seq" => event.id}}
                 {:error, reason} -> {:error, reason}
               end
             end
           ) do
      if status == :new and eviction_id do
        request_next_crypto_eviction(scope.kind, scope.group_id)
      end

      {:reply, {:ok, %{seq: result["seq"]}}, socket}
    else
      {:error, :epoch_conflict} -> transition_conflict_reply(scope, socket)
      {:error, reason} -> control_error_reply(reason, socket)
    end
  end

  def handle_mls_welcome(
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data} = payload,
        socket,
        scope
      )
      when is_binary(recipient_id) and is_binary(welcome_data) do
    with {:ok, decoded} <- safe_decode64(welcome_data),
         :ok <- authorize_mls_mutation(socket, scope),
         {:ok, idempotency_key} <- require_idempotency_key(payload),
         recipient_client_id = Map.get(payload, "recipient_device_id"),
         key_package_ref = Map.get(payload, "key_package_ref"),
         control_payload = %{
           recipient_id: recipient_id,
           recipient_client_id: recipient_client_id,
           key_package_ref: key_package_ref,
           welcome_data: welcome_data,
           membership_generation: Map.get(payload, "membership_generation")
         },
         {:ok, result, status} <-
           run_control_operation(
             socket,
             scope,
             "mls_welcome",
             idempotency_key,
             control_payload,
             fn ->
               with {:ok, welcome} <-
                      Encryption.store_pending_welcome(
                        %{
                          recipient_id: recipient_id,
                          recipient_client_id: recipient_client_id,
                          recipient_key_package_ref: key_package_ref,
                          group_id: scope.group_id,
                          welcome_data: decoded,
                          sender_id: socket.assigns.user_id
                        }
                        |> Map.put(scope.id_key, scope.resource_id)
                      ) do
                 {:ok,
                  %{
                    "id" => welcome.id,
                    "recipient_client_id" => welcome.recipient_client_id,
                    "key_package_ref" => welcome.recipient_key_package_ref
                  }}
               end
             end
           ) do
      if status == :new do
        broadcast!(socket, "mls_welcome", %{
          id: result["id"],
          recipient_id: recipient_id,
          recipient_device_id: result["recipient_client_id"],
          key_package_ref: result["key_package_ref"],
          welcome_data: welcome_data,
          sender_id: socket.assigns.user_id
        })
      end

      {:reply, {:ok, %{id: result["id"]}}, socket}
    else
      {:error, :invalid_base64} -> {:reply, {:error, %{reason: "invalid encoding"}}, socket}
      {:error, reason} -> control_error_reply(reason, socket)
    end
  end

  def handle_mls_history_request(payload, socket, scope, notify_fn) do
    requester_device_id =
      case Map.get(payload, "device_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    with {:ok, idempotency_key} <- require_idempotency_key(payload),
         membership_generation
         when is_integer(membership_generation) and membership_generation >= 0 <-
           Map.get(payload, "membership_generation"),
         {:ok, authorization} <-
           ControllerHelpers.authorize_history_scope(socket.assigns.user_id, scope.group_id),
         control_payload = %{
           requester_device_id: requester_device_id,
           membership_generation: membership_generation,
           authorization_generation: authorization.authorization_generation,
           authorized_after_room_seq: authorization.authorized_after_room_seq
         },
         {:ok, result, status} <-
           run_control_operation(
             socket,
             scope,
             "mls_history_request",
             idempotency_key,
             control_payload,
             fn ->
               with {:ok, request} <-
                      Encryption.store_pending_history_request(
                        %{
                          group_id: scope.group_id,
                          requester_id: socket.assigns.user_id,
                          requester_username: socket.assigns.username,
                          requester_client_id: requester_device_id,
                          membership_generation: membership_generation,
                          authorization_generation: authorization.authorization_generation,
                          authorized_after_room_seq: authorization.authorized_after_room_seq
                        }
                        |> Map.put(scope.id_key, scope.resource_id)
                      ) do
                 {:ok,
                  %{
                    "id" => request.id,
                    "authorization_generation" => request.authorization_generation,
                    "authorized_after_room_seq" => request.authorized_after_room_seq
                  }}
               end
             end
           ) do
      if status == :new do
        broadcast_from!(socket, "mls_history_request", %{
          id: result["id"],
          user_id: socket.assigns.user_id,
          device_id: requester_device_id,
          membership_generation: membership_generation,
          authorization_generation: result["authorization_generation"],
          authorized_after_room_seq: result["authorized_after_room_seq"]
        })

        notify_fn.()
      end

      {:reply, {:ok, %{id: result["id"]}}, socket}
    else
      {:error, reason} -> control_error_reply(reason, socket)
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
    recipient_device_id = optional_binary(Map.get(payload, "recipient_device_id"))
    request_id = optional_binary(Map.get(payload, "request_id"))
    membership_generation = Map.get(payload, "membership_generation")

    with {:ok, idempotency_key} <- require_idempotency_key(payload),
         :ok <- validate_required_uuid(request_id, "request_id"),
         {:ok, recipient_authorization} <-
           ControllerHelpers.authorize_history_scope(recipient_id, scope.group_id),
         control_payload = %{
           ciphertext: ciphertext,
           mls_epoch: epoch,
           recipient_id: recipient_id,
           recipient_device_id: recipient_device_id,
           request_id: request_id,
           membership_generation: membership_generation,
           authorization_generation: recipient_authorization.authorization_generation
         },
         {:ok, result, status} <-
           run_control_operation(
             socket,
             scope,
             "mls_history_bundle",
             idempotency_key,
             control_payload,
             fn ->
               attrs =
                 %{
                   group_id: scope.group_id,
                   ciphertext: ciphertext,
                   mls_epoch: epoch,
                   recipient_id: recipient_id,
                   recipient_client_id: recipient_device_id,
                   sender_id: socket.assigns.user_id,
                   membership_generation: membership_generation,
                   current_authorization_generation:
                     recipient_authorization.authorization_generation
                 }
                 |> Map.put(scope.id_key, scope.resource_id)

               with {:ok, bundle} <-
                      Encryption.fulfill_pending_history_request(request_id, attrs) do
                 {:ok,
                  %{
                    "id" => bundle.id,
                    "request_id" => bundle.request_id,
                    "membership_generation" => bundle.membership_generation,
                    "authorization_generation" => bundle.authorization_generation,
                    "authorized_after_room_seq" => bundle.authorized_after_room_seq
                  }}
               end
             end
           ) do
      if status == :new do
        broadcast!(socket, "mls_history_bundle", %{
          id: result["id"],
          request_id: result["request_id"],
          ciphertext: ciphertext,
          mls_epoch: epoch,
          membership_generation: result["membership_generation"],
          authorization_generation: result["authorization_generation"],
          authorized_after_room_seq: result["authorized_after_room_seq"],
          recipient_id: recipient_id,
          recipient_device_id: recipient_device_id,
          sender_id: socket.assigns.user_id
        })

        VesperWeb.Endpoint.broadcast("user:#{recipient_id}", "mls_history_bundle_pending", %{
          scope_id: scope.group_id,
          topic: scope.topic
        })
      end

      {:reply, {:ok, %{id: result["id"]}}, socket}
    else
      {:error, reason} -> control_error_reply(reason, socket)
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

  defp normalize_transition_payload(payload) do
    with epoch when is_integer(epoch) and epoch >= 1 <- parse_non_negative_epoch(payload, "epoch"),
         previous_epoch when is_integer(previous_epoch) and previous_epoch >= 0 <-
           parse_non_negative_epoch(payload, "previous_epoch"),
         {:ok, group_info_data} <- safe_decode64(Map.get(payload, "group_info_data")),
         {:ok, ratchet_tree_data} <-
           decode_optional_transition_binary(payload, "ratchet_tree_data"),
         {:ok, previous_transcript_hash} <-
           safe_decode64(Map.get(payload, "previous_transcript_hash")) do
      {:ok,
       %{
         epoch: epoch,
         previous_epoch: previous_epoch,
         group_info_data: group_info_data,
         ratchet_tree_data: ratchet_tree_data,
         previous_transcript_hash: previous_transcript_hash
       }}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_epoch_transition}
    end
  end

  defp decode_optional_transition_binary(payload, field) do
    case Map.get(payload, field) do
      nil -> {:ok, nil}
      value -> safe_decode64(value)
    end
  end

  defp parse_non_negative_epoch(payload, field) do
    case Map.get(payload, field) do
      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {parsed, ""} when parsed >= 0 -> parsed
          _ -> {:error, :invalid_epoch_transition}
        end

      _ ->
        {:error, :invalid_epoch_transition}
    end
  end

  defp require_present_idempotency_key(value) when is_binary(value) and value != "",
    do: {:ok, value}

  defp require_present_idempotency_key(_value), do: {:error, :missing_idempotency_key}

  defp authorize_mls_mutation(socket, scope) do
    case ControllerHelpers.authorize_mls_scope(socket.assigns.user_id, scope.group_id) do
      {:ok, authorization} ->
        if authorization.group_id == scope.group_id and
             authorization.channel_id == scope_value(scope, :channel_id) and
             authorization.conversation_id == scope_value(scope, :conversation_id) do
          :ok
        else
          {:error, :forbidden}
        end

      {:error, :not_found} ->
        # A channel may still exist while the socket's membership was revoked.
        # Do not expose the authorization lookup's legacy not-found distinction.
        {:error, :forbidden}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp scope_value(scope, :channel_id) when scope.id_key == :channel_id, do: scope.resource_id

  defp scope_value(scope, :conversation_id) when scope.id_key == :conversation_id,
    do: scope.resource_id

  defp scope_value(_scope, _key), do: nil

  defp transition_conflict_reply(scope, socket) do
    payload =
      case Encryption.get_group_info(scope.group_id) do
        nil ->
          %{reason: "epoch_conflict", current_epoch: nil}

        group_info ->
          %{
            reason: "epoch_conflict",
            current_epoch: group_info.epoch,
            current_transcript_hash: Base.encode64(Encryption.mls_transcript_hash(group_info))
          }
      end

    {:reply, {:error, payload}, socket}
  end

  defp valid_removal_fences?(removals, crypto_evictions) do
    length(removals) == length(crypto_evictions) and crypto_evictions != [] and
      Enum.all?(crypto_evictions, fn eviction ->
        is_binary(eviction.eviction_id) and is_integer(eviction.fencing_token) and
          is_integer(eviction.membership_generation)
      end)
  end

  defp require_idempotency_key(payload) do
    case optional_binary(Map.get(payload, "idempotency_key")) do
      nil -> {:error, :missing_idempotency_key}
      idempotency_key -> {:ok, idempotency_key}
    end
  end

  defp run_control_operation(
         socket,
         scope,
         operation,
         idempotency_key,
         payload,
         callback
       ) do
    case optional_binary(socket.assigns.device_client_id) do
      nil ->
        {:error, :missing_device_id}

      actor_client_id ->
        Encryption.run_control_operation(
          %{
            actor_id: socket.assigns.user_id,
            actor_client_id: actor_client_id,
            scope_kind: scope.kind,
            scope_id: scope.group_id,
            operation: operation,
            idempotency_key: idempotency_key
          },
          payload,
          callback
        )
    end
  end

  defp control_error_reply(:idempotency_conflict, socket),
    do: {:reply, {:error, %{reason: "idempotency_conflict"}}, socket}

  defp control_error_reply(:missing_idempotency_key, socket),
    do: {:reply, {:error, %{reason: "missing idempotency_key"}}, socket}

  defp control_error_reply(:missing_device_id, socket),
    do: {:reply, {:error, %{reason: "missing device_id"}}, socket}

  defp control_error_reply(:forbidden, socket),
    do: {:reply, {:error, %{reason: "not authorized"}}, socket}

  defp control_error_reply(:invalid_epoch_transition, socket),
    do: {:reply, {:error, %{reason: "invalid_epoch_transition"}}, socket}

  defp control_error_reply(:invalid_previous_transcript_hash, socket),
    do: {:reply, {:error, %{reason: "invalid_previous_transcript_hash"}}, socket}

  defp control_error_reply(:eviction_fence_required, socket),
    do: {:reply, {:error, %{reason: "eviction_fence_required"}}, socket}

  defp control_error_reply(:epoch_conflict, socket),
    do: {:reply, {:error, %{reason: "epoch_conflict"}}, socket}

  defp control_error_reply(reason, socket) when is_atom(reason),
    do: {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}

  defp control_error_reply(reason, socket) when is_binary(reason),
    do: {:reply, {:error, %{reason: reason}}, socket}

  defp control_error_reply(_reason, socket),
    do: {:reply, {:error, %{reason: "could not store control operation"}}, socket}

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

  def validate_required_uuid(nil, field), do: {:error, "missing #{field}"}

  def validate_required_uuid(value, field) do
    case Ecto.UUID.cast(value) do
      {:ok, _uuid} -> :ok
      :error -> {:error, "invalid #{field}"}
    end
  end

  def maybe_put(map, _key, nil), do: map
  def maybe_put(map, key, value), do: Map.put(map, key, value)

  def eviction_error_reason(:trusted_device_required), do: "trusted device required"
  def eviction_error_reason(:not_found), do: "eviction not found"
  def eviction_error_reason(:not_claimable), do: "eviction not claimable"
  def eviction_error_reason(:target_cannot_sponsor), do: "target cannot sponsor eviction"
  def eviction_error_reason(:target_mismatch), do: "eviction target mismatch"
  def eviction_error_reason(:target_device_mismatch), do: "eviction target device mismatch"
  def eviction_error_reason(:sponsor_mismatch), do: "eviction sponsor mismatch"
  def eviction_error_reason(:stale_fence), do: "stale eviction fence"
  def eviction_error_reason(:stale_generation), do: "stale membership generation"
  def eviction_error_reason(:lease_expired), do: "eviction lease expired"
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
