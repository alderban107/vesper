defmodule Vesper.Servers.MembershipCryptoLifecycleTest do
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.Accounts
  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Repo
  alias Vesper.Servers
  alias Vesper.Servers.MlsEvictionOutbox

  describe "membership removal outbox" do
    test "rolls back membership deletion when the durable outbox write fails" do
      %{server: server, member: member, membership: membership, text_channel: text_channel} =
        server_member_fixture()

      insert_device(member, %{client_id: "member-device"})

      reject_outbox_reason!("left")

      assert {:error, changeset} = Servers.leave_server(member.id, server.id)
      assert {"is invalid", _} = changeset.errors[:reason]
      assert Repo.get(Vesper.Servers.Membership, membership.id)
      assert Repo.aggregate(MlsEvictionOutbox, :count) == 0
      assert Encryption.list_pending_crypto_evictions("channel", text_channel.id) == []
    end

    test "rolls back a kick when the durable outbox write fails" do
      %{server: server, owner: owner, member: member, membership: membership} =
        server_member_fixture()

      insert_device(member, %{client_id: "member-device"})
      reject_outbox_reason!("kicked")

      assert {:error, changeset} = Servers.kick_member(server.id, member.id, actor_id: owner.id)
      assert {"is invalid", _} = changeset.errors[:reason]
      assert Repo.get(Vesper.Servers.Membership, membership.id)
      assert Repo.aggregate(MlsEvictionOutbox, :count) == 0
    end

    test "rolls back a ban and membership deletion when the durable outbox write fails" do
      %{server: server, owner: owner, member: member, membership: membership} =
        server_member_fixture()

      insert_device(member, %{client_id: "member-device"})
      reject_outbox_reason!("banned")

      assert {:error, changeset} = Servers.ban_member(server.id, member.id, owner.id)
      assert {"is invalid", _} = changeset.errors[:reason]
      assert Repo.get(Vesper.Servers.Membership, membership.id)
      refute Servers.banned?(server.id, member.id)
      assert Repo.aggregate(MlsEvictionOutbox, :count) == 0
    end

    test "recovers a committed obligation that has no Oban job" do
      %{server: server, member: member, text_channel: text_channel} = server_member_fixture()
      device = insert_device(member, %{client_id: "member-device"})

      outbox =
        insert_outbox(%{
          server_id: server.id,
          target_user_id: member.id,
          device_id: device.id,
          target_device_id: device.client_id,
          scope_kind: "channel",
          scope_id: text_channel.id,
          group_id: text_channel.id,
          cause: "membership_removed",
          reason: "kicked"
        })

      assert outbox.status == "pending"
      assert :ok = Servers.dispatch_pending_mls_eviction_outbox()

      assert Repo.get!(MlsEvictionOutbox, outbox.id).status == "handed_off"

      assert [eviction] = Encryption.list_pending_crypto_evictions("channel", text_channel.id)
      assert eviction.target_user_id == member.id
      assert eviction.target_device_id == device.client_id
    end
  end

  describe "device revocation" do
    test "creates one durable removal obligation for the exact device in every server MLS scope" do
      %{server: server, member: member, text_channel: text_channel, voice_channel: voice_channel} =
        server_member_fixture(with_voice?: true)

      revoked_device = insert_device(member, %{client_id: "revoked-device"})
      retained_device = insert_device(member, %{client_id: "retained-device"})

      assert {:ok, revoked} = Accounts.revoke_device(member.id, revoked_device.id)
      assert revoked.trust_state == "revoked"
      assert revoked.crypto_eviction_required_at
      refute Accounts.device_crypto_eviction_complete?(revoked)

      obligations =
        from(outbox in MlsEvictionOutbox,
          where: outbox.device_id == ^revoked_device.id,
          order_by: [asc: outbox.scope_kind, asc: outbox.scope_id]
        )
        |> Repo.all()

      assert Enum.map(obligations, &{&1.scope_kind, &1.scope_id, &1.group_id}) ==
               [
                 {"channel", text_channel.id, text_channel.id},
                 {"voice", voice_channel.id, "voice:channel:#{voice_channel.id}"}
               ]

      assert Enum.all?(obligations, &(&1.target_user_id == member.id))
      assert Enum.all?(obligations, &(&1.target_device_id == revoked_device.client_id))
      assert Enum.all?(obligations, &(&1.status == "handed_off"))

      refute Repo.exists?(
               from(outbox in MlsEvictionOutbox, where: outbox.device_id == ^retained_device.id)
             )

      assert [text_eviction] =
               Encryption.list_pending_crypto_evictions("channel", text_channel.id)

      assert text_eviction.target_device_id == revoked_device.client_id

      assert [voice_eviction] =
               Encryption.list_pending_crypto_evictions("voice", voice_channel.id)

      assert voice_eviction.group_id == "voice:channel:#{voice_channel.id}"
      assert voice_eviction.target_device_id == revoked_device.client_id

      assert server.id == text_eviction.server_id
      assert server.id == voice_eviction.server_id
    end

    test "hands off channel-backed DM and voice-DM device evictions" do
      user = insert_user()
      peer = insert_user()
      revoked_device = insert_device(user, %{client_id: "revoked-dm-device"})
      assert {:ok, conversation} = Chat.create_conversation(user.id, [peer.id])
      assert is_binary(conversation.channel_id)

      assert {:ok, _revoked} = Accounts.revoke_device(user.id, revoked_device.id)

      obligations =
        from(outbox in MlsEvictionOutbox,
          where: outbox.device_id == ^revoked_device.id,
          order_by: [asc: outbox.scope_kind]
        )
        |> Repo.all()

      assert Enum.map(obligations, &{&1.scope_kind, &1.scope_id, &1.group_id, &1.server_id}) == [
               {"channel", conversation.channel_id, conversation.channel_id, nil},
               {"voice_dm", conversation.id, "voice:dm:#{conversation.id}", nil}
             ]

      assert Enum.all?(obligations, &(&1.status == "handed_off"))

      assert [dm_eviction] =
               Encryption.list_pending_crypto_evictions("channel", conversation.channel_id)

      assert dm_eviction.server_id == nil
      assert dm_eviction.target_device_id == revoked_device.client_id

      assert [voice_eviction] =
               Encryption.list_pending_crypto_evictions("voice_dm", conversation.id)

      assert voice_eviction.server_id == nil
      assert voice_eviction.group_id == "voice:dm:#{conversation.id}"
    end

    test "does not re-trust a revoked device before its obligations can complete" do
      user = insert_user()
      device = insert_device(user, %{client_id: "revoked-device"})

      assert {:ok, revoked} = Accounts.revoke_device(user.id, device.id)
      assert {:error, :device_revoked} = Accounts.approve_device(user.id, device.id)

      assert {:ok, existing} =
               Accounts.ensure_device(
                 user,
                 [client_id: device.client_id, name: "Replacement session", platform: "test"],
                 "trusted"
               )

      assert existing.id == revoked.id
      assert existing.trust_state == "revoked"
      assert existing.revoked_at
    end
  end

  describe "ownership invariant" do
    test "transfers owner_id and owner role together and rejects role-only ownership changes" do
      owner = insert_user()
      successor = insert_user()
      outsider = insert_user()
      server = insert_server(owner)
      owner_membership = insert_membership(owner, server, %{role: "owner"})
      successor_membership = insert_membership(successor, server)

      assert {:error, :owner_role_managed_by_server} =
               Servers.update_membership_role(successor_membership, "owner")

      assert {:error, :owner_role_managed_by_server} =
               Servers.update_membership_role(owner_membership, "member")

      assert {:error, :new_owner_not_member} =
               Servers.transfer_ownership(server.id, owner.id, outsider.id)

      assert {:ok, updated_owner_membership} =
               Servers.transfer_ownership(server.id, owner.id, successor.id)

      assert updated_owner_membership.user_id == successor.id
      assert updated_owner_membership.role == "owner"
      assert Repo.get!(Vesper.Servers.Server, server.id).owner_id == successor.id
      assert Servers.get_membership(owner.id, server.id).role == "member"
      assert Servers.get_membership(successor.id, server.id).role == "owner"

      assert {:error, :not_owner} = Servers.transfer_ownership(server.id, owner.id, outsider.id)
    end
  end

  defp server_member_fixture(opts \\ []) do
    owner = insert_user()
    member = insert_user()
    server = insert_server(owner)
    _owner_membership = insert_membership(owner, server, %{role: "owner"})
    membership = insert_membership(member, server)
    text_channel = insert_channel(server, %{type: "text"})

    voice_channel =
      if Keyword.get(opts, :with_voice?, false) do
        insert_channel(server, %{type: "voice"})
      end

    %{
      server: server,
      owner: owner,
      member: member,
      membership: membership,
      text_channel: text_channel,
      voice_channel: voice_channel
    }
  end

  defp reject_outbox_reason!(reason) do
    Repo.query!("""
    ALTER TABLE mls_eviction_outbox
    ADD CONSTRAINT mls_eviction_outbox_reason_check CHECK (reason <> '#{reason}')
    """)

    on_exit(fn ->
      Repo.query!(
        "ALTER TABLE mls_eviction_outbox DROP CONSTRAINT IF EXISTS mls_eviction_outbox_reason_check"
      )
    end)
  end

  defp insert_outbox(attrs) do
    defaults = %{
      scope_kind: "channel",
      scope_id: Ecto.UUID.generate(),
      group_id: Ecto.UUID.generate(),
      target_device_id: "device",
      cause: "membership_removed",
      status: "pending"
    }

    %MlsEvictionOutbox{}
    |> MlsEvictionOutbox.changeset(Map.merge(defaults, attrs))
    |> Repo.insert!()
  end
end
