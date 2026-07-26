defmodule VesperWeb.CohortChannel do
  use Phoenix.Channel

  alias Vesper.Encryption
  alias VesperWeb.MlsHandler

  @impl true
  def join("crypto:cohort:" <> group_id, _payload, socket) do
    case Encryption.get_active_user_cohort(group_id, socket.assigns.user_id) do
      {cohort, topology, room} ->
        {kind, resource_id, id_key} = room_scope(room)

        socket =
          socket
          |> assign(:cohort_id, cohort.id)
          |> assign(:topology_id, topology.id)
          |> assign(:group_id, group_id)
          |> assign(:scope_kind, kind)
          |> assign(:resource_id, resource_id)
          |> assign(:resource_id_key, id_key)

        send(self(), :replay_mls_join_broadcasts)
        {:ok, socket}

      nil ->
        {:error, %{reason: "cohort not found or not assigned"}}
    end
  end

  @impl true
  def handle_in("mls_request_join", payload, socket) when is_map(payload),
    do: MlsHandler.handle_mls_request_join(payload, socket)

  def handle_in("mls_request_join_all", _payload, socket),
    do: MlsHandler.handle_mls_request_join_all(socket, mls_scope(socket))

  def handle_in("mls_resync_request", payload, socket) when is_map(payload),
    do: MlsHandler.handle_mls_resync_request(payload, socket, mls_scope(socket))

  def handle_in("mls_commit", %{"commit_data" => commit_data} = payload, socket)
      when is_binary(commit_data),
      do: MlsHandler.handle_mls_commit(payload, socket, mls_scope(socket))

  def handle_in("mls_eviction_claim", %{"id" => id} = payload, socket) when is_binary(id),
    do: MlsHandler.handle_mls_eviction_claim(payload, socket, mls_scope(socket))

  def handle_in("mls_eviction_skip", %{"id" => id} = payload, socket) when is_binary(id),
    do: MlsHandler.handle_mls_eviction_skip(payload, socket, mls_scope(socket))

  def handle_in(
        "mls_remove",
        %{"removed_user_id" => user_id, "commit_data" => commit_data} = payload,
        socket
      )
      when is_binary(user_id) and is_binary(commit_data),
      do: MlsHandler.handle_mls_remove(payload, socket, mls_scope(socket))

  def handle_in(
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data} = payload,
        socket
      )
      when is_binary(recipient_id) and is_binary(welcome_data),
      do: MlsHandler.handle_mls_welcome(payload, socket, mls_scope(socket))

  def handle_in("mls_history_request", payload, socket) when is_map(payload),
    do: MlsHandler.handle_mls_history_request(payload, socket, mls_scope(socket), fn -> :ok end)

  def handle_in(
        "mls_history_bundle",
        %{"ciphertext" => _, "mls_epoch" => _, "recipient_id" => _} = payload,
        socket
      ),
      do: MlsHandler.handle_mls_history_bundle(payload, socket, mls_scope(socket))

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  @impl true
  def handle_info(:replay_mls_join_broadcasts, socket) do
    MlsHandler.replay_mls_join_broadcasts(socket, socket.assigns.group_id)
    {:noreply, socket}
  end

  def handle_info(_message, socket), do: {:noreply, socket}

  defp mls_scope(socket) do
    %{
      kind: socket.assigns.scope_kind,
      group_id: socket.assigns.group_id,
      resource_id: socket.assigns.resource_id,
      id_key: socket.assigns.resource_id_key,
      topic: "crypto:cohort:#{socket.assigns.group_id}"
    }
  end

  defp room_scope(%{channel_id: channel_id}) when is_binary(channel_id),
    do: {"channel", channel_id, :channel_id}

  defp room_scope(%{conversation_id: conversation_id}) when is_binary(conversation_id),
    do: {"dm", conversation_id, :conversation_id}
end
