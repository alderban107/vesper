defmodule Vesper.Notifications do
  @moduledoc """
  Web Push notification delivery for offline users.

  Sends push notifications via the Web Push Protocol (RFC 8030 + VAPID).
  The server never sends message content — only metadata (sender name,
  channel/server name) to preserve E2EE guarantees.
  """

  require Logger

  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Accounts
  alias Vesper.Accounts.Device

  @doc """
  Returns the VAPID public key for client-side push subscription, or nil if
  push is not configured.
  """
  def vapid_public_key do
    if push_enabled?() do
      Application.get_env(:web_push_elixir, :vapid_public_key)
    end
  end

  @doc """
  Returns true when VAPID keys are configured and push is available.
  """
  def push_enabled? do
    Application.get_env(:vesper, :web_push_enabled, false)
  end

  @doc """
  Send a web push notification to a single device. Returns :ok or logs errors.
  The subscription JSON is stored in device.push_token.
  """
  def send_web_push(%Device{push_token: token}, _payload) when is_nil(token), do: :ok

  def send_web_push(%Device{push_token: subscription_json} = device, payload) do
    message = Jason.encode!(payload)

    case WebPushElixir.send_notification(subscription_json, message) do
      {:ok, _response} ->
        :ok

      {:error, :expired} ->
        Logger.info("Push subscription expired for device %s, clearing token",
          device_id: device.id
        )

        clear_push_token(device)
        :ok

      {:error, reason} ->
        Logger.warning("Push delivery failed for device %s: %s",
          device_id: device.id,
          reason: inspect(reason)
        )

        :ok
    end
  end

  @doc """
  Push to all offline devices with push tokens for the given user IDs.
  Runs asynchronously under Vesper.NotificationSupervisor.
  """
  def notify_offline_users(user_ids, sender_id, payload) when is_list(user_ids) do
    if not push_enabled?() do
      :ok
    else
      recipient_ids = Enum.reject(user_ids, &(&1 == sender_id))

      Task.Supervisor.start_child(Vesper.NotificationSupervisor, fn ->
        for user_id <- recipient_ids do
          if user_offline?(user_id) do
            devices = list_push_devices(user_id)

            for device <- devices do
              send_web_push(device, payload)
            end
          end
        end
      end)

      :ok
    end
  end

  @doc """
  Push notification for channel @mentions. Only pushes to mentioned users
  who are offline.
  """
  def notify_mentioned_users(mentioned_user_ids, sender_id, channel_id, server_id)
      when is_list(mentioned_user_ids) and mentioned_user_ids != [] do
    if not push_enabled?(), do: :ok

    Task.Supervisor.start_child(Vesper.NotificationSupervisor, fn ->
      {sender_name, channel_name, server_name} =
        lookup_channel_context(sender_id, channel_id, server_id)

      payload = %{
        type: "mention",
        sender_name: sender_name,
        channel_name: channel_name,
        server_name: server_name,
        scope_type: "channel",
        scope_id: channel_id
      }

      for user_id <- mentioned_user_ids, user_id != sender_id do
        if user_offline?(user_id) do
          for device <- list_push_devices(user_id) do
            send_web_push(device, payload)
          end
        end
      end
    end)

    :ok
  end

  def notify_mentioned_users(_, _, _, _), do: :ok

  @doc """
  Push notification for DM messages. Pushes to all participants except sender.
  """
  def notify_dm_message(sender_id, conversation_id, participant_ids)
      when is_list(participant_ids) do
    if not push_enabled?(), do: :ok

    Task.Supervisor.start_child(Vesper.NotificationSupervisor, fn ->
      sender_name = lookup_sender_name(sender_id)

      payload = %{
        type: "dm",
        sender_name: sender_name,
        scope_type: "dm",
        scope_id: conversation_id
      }

      for user_id <- participant_ids, user_id != sender_id do
        if user_offline?(user_id) do
          for device <- list_push_devices(user_id) do
            send_web_push(device, payload)
          end
        end
      end
    end)

    :ok
  end

  @doc """
  Push notification for incoming DM voice calls.
  """
  def notify_incoming_call(caller_id, conversation_id, participant_ids)
      when is_list(participant_ids) do
    if not push_enabled?(), do: :ok

    Task.Supervisor.start_child(Vesper.NotificationSupervisor, fn ->
      caller_name = lookup_sender_name(caller_id)

      payload = %{
        type: "call",
        caller_name: caller_name,
        scope_type: "dm",
        scope_id: conversation_id
      }

      for user_id <- participant_ids, user_id != caller_id do
        if user_offline?(user_id) do
          for device <- list_push_devices(user_id) do
            send_web_push(device, payload)
          end
        end
      end
    end)

    :ok
  end

  # -- Private helpers --

  defp user_offline?(user_id) do
    VesperWeb.Presence.list("user:#{user_id}") == %{}
  end

  defp list_push_devices(user_id) do
    from(d in Device,
      where: d.user_id == ^user_id,
      where: not is_nil(d.push_token),
      where: d.trust_state == "trusted"
    )
    |> Repo.all()
  end

  defp clear_push_token(%Device{} = device) do
    device
    |> Ecto.Changeset.change(push_token: nil, push_platform: nil)
    |> Repo.update()
  end

  defp lookup_sender_name(user_id) do
    case Accounts.get_user(user_id) do
      nil -> "Someone"
      user -> user.display_name || user.username
    end
  end

  defp lookup_channel_context(sender_id, channel_id, server_id) do
    sender_name = lookup_sender_name(sender_id)

    channel_name =
      case Vesper.Servers.get_channel(channel_id) do
        nil -> "a channel"
        channel -> channel.name
      end

    server_name =
      case Vesper.Servers.get_server(server_id) do
        nil -> "a server"
        server -> server.name
      end

    {sender_name, channel_name, server_name}
  end
end
