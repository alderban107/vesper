defmodule Vesper.ChatTest do
  use Vesper.DataCase, async: true

  alias Vesper.Chat
  import Vesper.Factory

  describe "create_message/1" do
    test "creates an encrypted channel message" do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      {:ok, msg} =
        Chat.create_message(%{
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          channel_id: channel.id,
          sender_id: user.id
        })

      assert msg.ciphertext
      assert msg.mls_epoch == 1
      assert msg.sender.username == user.username
    end

    test "creates an encrypted DM message" do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      {:ok, msg} =
        Chat.create_message(%{
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          conversation_id: conv.id,
          sender_id: user1.id
        })

      assert msg.ciphertext
      assert msg.conversation_id == conv.id
    end

    test "rejects message with no channel or conversation" do
      user = create_user()

      {:error, changeset} =
        Chat.create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, sender_id: user.id})

      assert errors_on(changeset).channel_id
    end

    test "rejects message without ciphertext" do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      {:error, changeset} =
        Chat.create_message(%{channel_id: channel.id, sender_id: user.id})

      assert errors_on(changeset).ciphertext
    end
  end

  describe "list_channel_messages/2" do
    test "returns messages for the channel" do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      for _i <- 1..3 do
        create_message(%{
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          channel_id: channel.id,
          sender_id: user.id
        })
      end

      messages = Chat.list_channel_messages(channel.id, limit: 10)
      assert length(messages) == 3
    end

    test "respects limit" do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      for i <- 1..5 do
        create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, channel_id: channel.id, sender_id: user.id})
      end

      assert length(Chat.list_channel_messages(channel.id, limit: 2)) == 2
    end
  end

  describe "DM conversations" do
    test "create_conversation creates a direct conversation" do
      user1 = create_user()
      user2 = create_user()

      {:ok, conv} = Chat.create_conversation(user1.id, [user2.id])
      assert conv.type == "direct"
      assert length(conv.participants) == 2
    end

    test "create_conversation returns existing for duplicate direct DM" do
      user1 = create_user()
      user2 = create_user()

      {:ok, conv1} = Chat.create_conversation(user1.id, [user2.id])
      {:ok, conv2} = Chat.create_conversation(user1.id, [user2.id])
      assert conv1.id == conv2.id
    end

    test "create_conversation creates a group conversation" do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()

      {:ok, conv} = Chat.create_conversation(user1.id, [user2.id, user3.id], name: "Group")
      assert conv.type == "group"
      assert conv.name == "Group"
      assert length(conv.participants) == 3
    end

    test "list_conversations returns user's conversations" do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()

      create_conversation(user1.id, [user2.id])
      create_conversation(user1.id, [user3.id])

      results = Chat.list_conversations(user1.id)
      assert length(results) == 2
    end

    test "get_conversation returns conversation with participants" do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      result = Chat.get_conversation(conv.id)
      assert result.id == conv.id
      assert length(result.participants) == 2
    end

    test "user_is_participant? checks membership" do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      assert Chat.user_is_participant?(user1.id, conv.id)
      assert Chat.user_is_participant?(user2.id, conv.id)
      refute Chat.user_is_participant?(user3.id, conv.id)
    end

    test "list_conversation_messages returns DM messages" do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, conversation_id: conv.id, sender_id: user1.id})
      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, conversation_id: conv.id, sender_id: user2.id})

      messages = Chat.list_conversation_messages(conv.id, limit: 10)
      assert length(messages) == 2
    end
  end
end
