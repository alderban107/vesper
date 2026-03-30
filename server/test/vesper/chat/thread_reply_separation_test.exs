defmodule Vesper.Chat.ThreadReplySeparationTest do
  use Vesper.DataCase, async: true

  alias Vesper.Chat

  describe "thread message queries" do
    test "exclude inline replies from thread reply lists and counts" do
      user = insert_user()
      server = insert_server(user)
      channel = insert_channel(server)

      parent = insert_message(user, channel)
      thread_reply = insert_message(user, channel, %{parent_message_id: parent.id, is_reply: false})
      _inline_reply = insert_message(user, channel, %{parent_message_id: parent.id, is_reply: true})

      assert [returned_reply] = Chat.list_thread_messages(parent.id)
      assert returned_reply.id == thread_reply.id

      assert Chat.count_thread_replies(parent.id) == 1
    end

    test "include thread-internal replies that carry a separate reply target" do
      user = insert_user()
      server = insert_server(user)
      channel = insert_channel(server)

      parent = insert_message(user, channel)

      first_thread_message =
        insert_message(user, channel, %{
          parent_message_id: parent.id,
          thread_root_message_id: parent.id,
          is_reply: false
        })

      second_thread_message =
        insert_message(user, channel, %{
          parent_message_id: parent.id,
          thread_root_message_id: parent.id,
          reply_to_message_id: first_thread_message.id,
          is_reply: false
        })

      replies = Chat.list_thread_messages(parent.id)
      assert Enum.map(replies, & &1.id) == [first_thread_message.id, second_thread_message.id]
      assert Chat.count_thread_replies(parent.id) == 2
    end
  end
end
