defmodule Vesper.MlsOrderingAdversarialTest do
  @moduledoc """
  Cross-layer adversarial coverage matrix.

  | Scenario | Oracle | Status |
  | --- | --- | --- |
  | Offline surviving peer replays a remove | Durable cursor returns the remove exactly once, before later External Commit traffic | executable |
  | Local-target remove, recovery, then replay | Target-specific removal is durable and the post-remove cursor contains only later transitions | executable at relay boundary; SDK reset/rejoin requires a controllable MLS peer fixture |
  | Sponsored commit before Welcome across restart | Reloaded rows contain remove -> sponsored commit and a recipient/device Welcome; every transition event has an ordered outbox record | executable |
  | Ordinary remove versus External Commit | Distinct event payloads preserve transition type and generation under one cursor | executable |
  | Stale application send versus epoch advance | Ciphertext epoch must be checked against a live MLS state while a commit races | blocked: no deterministic SDK hook between encryption and message persistence |
  | First DM recipient offline, then sender devices disappear | Recipient must join and decrypt from durable GroupInfo/events without a live sender | SDK integration fixture required |
  | Device revocation cryptographic exclusion | Revocation creates per-scope, per-device MLS eviction work, not only an auth denial | executable |
  | Membership delete versus eviction-outbox failure | Membership deletion leaves durable fenced eviction rows even when later dispatch is unavailable | executable at durable-row boundary; injecting an Oban insert failure is not supported |
  | Sponsored dispatch loss | Later dispatch is blocked until the failed transition is delivered, while replay rows remain | executable for ordinary transitions; sponsored transition outbox assertion is executable |
  | Voice membership eviction | A joined voice socket must terminate on the membership-revoked PubSub event | blocked: the current test harness has no controllable Voice.Room media setup independent of the channel join |
  | Legacy DM without channel_id | Legacy conversation routing must remain explicit and fail safely during migration | blocked: no supported fixture or migration entry point creates a legacy room without bypassing invariants |
  | Attachment upload/send crash boundary | Upload remains uploader-owned until the message transaction claims it, and a restart replays a persisted send intent | blocked: crash injection between upload acknowledgement and SDK outbox clearing is not exposed |

  The executable cases intentionally assert protocol durability rather than websocket
  delivery alone: ordered MLS event ids, durable outbox rows, eviction rows, and
  recipient/device-scoped Welcome rows are the recovery inputs after a process restart.
  """

  use Vesper.ChannelCase, async: false

  import Ecto.Query

  alias Vesper.Accounts
  alias Vesper.Dispatch
  alias Vesper.DispatchOutbox
  alias Vesper.Encryption
  alias Vesper.Servers
  alias Vesper.Servers.MlsEvictionOutbox

  test "a replay cursor preserves remove before later External Commit traffic" do
    sponsor = insert_user()
    removed_user = insert_user()
    joining_user = insert_user()
    group_id = Ecto.UUID.generate()

    assert {:ok, ordinary_commit} =
             Encryption.store_mls_commit_event(%{
               group_id: group_id,
               event_type: "mls_commit",
               payload: %{
                 commit_data: "ordinary-commit",
                 transition_type: "ordinary_commit",
                 resulting_generation: 1
               },
               sender_id: sponsor.id,
               sender_device_id: "sponsor-device",
               idempotency_key: "ordinary-commit"
             })

    assert {:ok, remove_event} =
             Encryption.store_mls_remove_event(%{
               group_id: group_id,
               event_type: "mls_remove",
               payload: %{
                 removed_user_id: removed_user.id,
                 removed_device_id: "removed-device",
                 commit_data: "remove-commit",
                 resulting_generation: 2
               },
               sender_id: sponsor.id,
               sender_device_id: "sponsor-device"
             })

    assert {:ok, external_commit} =
             Encryption.store_mls_commit_event(%{
               group_id: group_id,
               event_type: "mls_commit",
               payload: %{
                 commit_data: "external-commit",
                 transition_type: "external_commit",
                 joined_user_id: joining_user.id,
                 joined_device_id: "joining-device",
                 resulting_generation: 3
               },
               sender_id: joining_user.id,
               sender_device_id: "joining-device",
               idempotency_key: "external-commit"
             })

    assert Enum.map(Encryption.list_mls_events_after(group_id, 0), & &1.id) == [
             ordinary_commit.id,
             remove_event.id,
             external_commit.id
           ]

    [replayed_remove, replayed_external] =
      Encryption.list_mls_events_after(group_id, ordinary_commit.id)

    assert replayed_remove.id == remove_event.id
    assert replayed_remove.event_type == "mls_remove"
    assert replayed_remove.payload["removed_user_id"] == removed_user.id
    assert replayed_remove.payload["removed_device_id"] == "removed-device"
    assert replayed_remove.payload["resulting_generation"] == 2

    assert replayed_external.id == external_commit.id
    assert replayed_external.payload["transition_type"] == "external_commit"
    assert replayed_external.payload["joined_user_id"] == joining_user.id
    assert replayed_external.payload["resulting_generation"] == 3

    assert ordered_dispatch_keys(group_id) == [
             "mls_event:#{ordinary_commit.id}",
             "mls_event:#{remove_event.id}",
             "mls_event:#{external_commit.id}"
           ]
  end

  test "sponsored transition survives reload with remove, commit, Welcome, and ordered dispatches" do
    sponsor = insert_user()
    recipient = insert_user()
    group_id = Ecto.UUID.generate()

    assert {:ok, initial_group_info} =
             Encryption.publish_group_info(%{
               group_id: group_id,
               group_info_data: <<0>>,
               ratchet_tree_data: <<1>>,
               epoch: 0,
               publisher_id: sponsor.id,
               publisher_client_id: "sponsor-device"
             })

    attrs = %{
      group_id: group_id,
      group_info_data: <<2>>,
      ratchet_tree_data: <<3>>,
      epoch: 1,
      previous_epoch: 0,
      previous_transcript_hash: Encryption.mls_transcript_hash(initial_group_info),
      recipient_id: recipient.id,
      recipient_client_id: "recipient-device",
      recipient_key_package_ref: "recipient-key-package",
      remove_commit_data: "remove-before-welcome",
      commit_data: "sponsored-commit",
      commit_id: "sponsored-transition-id",
      welcome_data: <<4, 5>>,
      sender_id: sponsor.id,
      sender_device_id: "sponsor-device"
    }

    assert {:ok,
            %{
              fresh: true,
              remove_event: remove_event,
              commit_event: commit_event,
              welcome: welcome
            }} =
             Encryption.publish_sponsored_transition(attrs)

    # Re-fetch every recovery input as a new process would. No in-memory result
    # is used below.
    assert [stored_remove, stored_commit] = Encryption.list_mls_events_after(group_id, 0)
    assert stored_remove.id == remove_event.id
    assert stored_remove.payload["commit_data"] == "remove-before-welcome"
    assert stored_remove.payload["removed_user_id"] == recipient.id
    assert stored_remove.payload["removed_device_id"] == "recipient-device"

    assert stored_commit.id == commit_event.id
    assert stored_commit.payload["commit_data"] == "sponsored-commit"
    assert stored_commit.payload["transition_type"] == "sponsored_join"
    assert stored_commit.payload["joined_user_id"] == recipient.id
    assert stored_commit.payload["joined_device_id"] == "recipient-device"

    [stored_welcome] = Encryption.get_pending_welcomes(recipient.id, group_id, "recipient-device")
    assert stored_welcome.id == welcome.id
    assert stored_welcome.recipient_key_package_ref == "recipient-key-package"
    assert stored_welcome.welcome_data == <<4, 5>>

    assert ordered_dispatch_keys(group_id) == [
             "mls_event:#{remove_event.id}",
             "mls_event:#{commit_event.id}"
           ]
  end

  test "a failed relay never lets a later MLS transition overtake the durable remove" do
    sponsor = insert_user()
    removed_user = insert_user()
    joining_user = insert_user()
    group_id = Ecto.UUID.generate()

    assert {:ok, remove_event} =
             Encryption.store_mls_remove_event(%{
               group_id: group_id,
               event_type: "mls_remove",
               payload: %{
                 removed_user_id: removed_user.id,
                 removed_device_id: "removed-device",
                 commit_data: "remove-commit",
                 resulting_generation: 1
               },
               sender_id: sponsor.id,
               sender_device_id: "sponsor-device"
             })

    assert {:ok, external_commit} =
             Encryption.store_mls_commit_event(%{
               group_id: group_id,
               event_type: "mls_commit",
               payload: %{
                 commit_data: "external-commit",
                 transition_type: "external_commit",
                 joined_user_id: joining_user.id,
                 joined_device_id: "joining-device",
                 resulting_generation: 2
               },
               sender_id: joining_user.id,
               sender_device_id: "joining-device",
               idempotency_key: "external-commit-after-remove"
             })

    # Insert delivery records directly so the test owns the relay timing; the
    # production outbox worker may otherwise deliver Encryption's records before
    # the failure injection runs.
    remove_dispatch =
      insert_dispatch!(
        "adversarial-remove:#{remove_event.id}",
        group_id,
        remove_event.id,
        "mls_remove"
      )

    external_dispatch =
      insert_dispatch!(
        "adversarial-external-commit:#{external_commit.id}",
        group_id,
        external_commit.id,
        "mls_commit"
      )

    assert {:error, "injected relay loss"} =
             Dispatch.deliver(remove_dispatch.id, fn _topic, _event, _payload ->
               raise "injected relay loss"
             end)

    assert {:snooze, 1} = Dispatch.deliver(external_dispatch.id, fn _, _, _ -> :ok end)
    assert Repo.get!(DispatchOutbox, external_dispatch.id).status == "pending"

    assert :ok = Dispatch.deliver(remove_dispatch.id, fn _, _, _ -> :ok end)
    assert :ok = Dispatch.deliver(external_dispatch.id, fn _, _, _ -> :ok end)

    assert Enum.map(Encryption.list_mls_events_after(group_id, 0), & &1.id) == [
             remove_event.id,
             external_commit.id
           ]

    assert Repo.get!(DispatchOutbox, remove_dispatch.id).status == "delivered"
    assert Repo.get!(DispatchOutbox, external_dispatch.id).status == "delivered"
  end

  test "membership deletion leaves durable per-device MLS eviction work" do
    owner = insert_user()
    departing_user = insert_user()
    departing_device = insert_device(departing_user, %{client_id: "departing-device"})
    {:ok, server} = Servers.create_server(owner, %{name: "adversarial eviction server"})
    {:ok, _} = Servers.join_server(departing_user, server.invite_code)
    text_channel = Enum.find(server.channels, &(&1.type == "text"))

    assert {:ok, _membership} = Servers.leave_server(departing_user.id, server.id)
    assert is_nil(Servers.get_membership(departing_user.id, server.id))

    assert [eviction] =
             Encryption.list_pending_crypto_evictions("channel", text_channel.id)

    assert eviction.target_user_id == departing_user.id
    assert eviction.target_device_id == departing_device.client_id
    assert eviction.reason == "left"
    assert eviction.status in ["pending", "requested"]
    assert is_integer(eviction.membership_generation)
    assert is_integer(eviction.fencing_token)
  end

  test "device revocation creates scope eviction work for the revoked MLS leaf" do
    owner = insert_user()
    device = insert_device(owner, %{client_id: "revoked-device"})
    {:ok, server} = Servers.create_server(owner, %{name: "device revocation crypto server"})
    text_channel = Enum.find(server.channels, &(&1.type == "text"))

    assert {:ok, _revoked_device} = Accounts.revoke_device(owner.id, device.id)

    assert [outbox] =
             Repo.all(
               from(entry in MlsEvictionOutbox,
                 where:
                   entry.scope_kind == "channel" and entry.scope_id == ^text_channel.id and
                     entry.target_user_id == ^owner.id and
                     entry.target_device_id == "revoked-device"
               )
             )

    assert outbox.device_id == device.id
    assert outbox.cause == "device_revoked"
    assert outbox.reason == "device_revoked"
    assert outbox.status in ["pending", "handed_off"]
  end

  defp insert_dispatch!(durable_key, group_id, ordering_key, event) do
    %DispatchOutbox{}
    |> DispatchOutbox.changeset(%{
      durable_key: durable_key,
      scope_key: "group:#{group_id}",
      scope_topic: "group:#{group_id}",
      ordering_key: ordering_key,
      event: event,
      payload: %{}
    })
    |> Repo.insert!()
  end

  defp ordered_dispatch_keys(group_id) do
    Repo.all(
      from(dispatch in DispatchOutbox,
        where: dispatch.scope_key == ^"group:#{group_id}",
        order_by: [asc: dispatch.ordering_key],
        select: dispatch.durable_key
      )
    )
  end
end
