defmodule VesperWeb.VoiceChannelTest do
  use Vesper.DataCase, async: true

  import Phoenix.ChannelTest
  import Vesper.Factory

  @endpoint VesperWeb.Endpoint

  alias VesperWeb.UserSocket

  describe "join voice:channel:*" do
    test "member can join a voice channel" do
      user = create_user()
      server = create_server(user)
      channel = create_voice_channel(server.id)

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(user)})

      assert {:ok, _, _socket} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:channel:#{channel.id}"
               )
    end

    test "non-member cannot join a voice channel" do
      owner = create_user()
      outsider = create_user()
      server = create_server(owner)
      channel = create_voice_channel(server.id)

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(outsider)})

      assert {:error, %{reason: "channel not found or not a member"}} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:channel:#{channel.id}"
               )
    end

    test "cannot join a text channel as voice" do
      user = create_user()
      server = create_server(user)
      channel = create_channel(server.id, %{"type" => "text"})

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(user)})

      assert {:error, %{reason: "not a voice channel"}} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:channel:#{channel.id}"
               )
    end

    test "cannot join with nonexistent channel id" do
      user = create_user()
      _server = create_server(user)

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(user)})

      assert {:error, %{reason: "channel not found or not a member"}} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:channel:#{Ecto.UUID.generate()}"
               )
    end
  end

  describe "join voice:dm:*" do
    test "DM participant can join voice" do
      user1 = create_user()
      user2 = create_user()
      conversation = create_conversation(user1.id, [user2.id])

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(user1)})

      assert {:ok, _, _socket} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:dm:#{conversation.id}"
               )
    end

    test "non-participant cannot join voice DM" do
      user1 = create_user()
      user2 = create_user()
      outsider = create_user()
      conversation = create_conversation(user1.id, [user2.id])

      {:ok, socket} = connect(UserSocket, %{"token" => make_token(outsider)})

      assert {:error, %{reason: "not a participant"}} =
               Phoenix.ChannelTest.subscribe_and_join(
                 socket,
                 VesperWeb.VoiceChannel,
                 "voice:dm:#{conversation.id}"
               )
    end
  end

  defp make_token(user) do
    {:ok, tokens} = Vesper.Accounts.create_tokens(user)
    tokens.access_token
  end
end
