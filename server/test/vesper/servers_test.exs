defmodule Vesper.ServersTest do
  use Vesper.DataCase, async: true

  alias Vesper.Servers
  import Vesper.Factory

  describe "create_server/2" do
    test "creates server with general channel and owner membership" do
      user = create_user()
      {:ok, server} = Servers.create_server(user, %{"name" => "My Server"})

      assert server.name == "My Server"
      assert server.owner_id == user.id
      assert server.invite_code
      assert length(server.channels) == 1
      assert hd(server.channels).name == "general"
    end
  end

  describe "list_user_servers/1" do
    test "returns servers the user belongs to" do
      user = create_user()
      create_server(user, %{"name" => "Server1"})
      create_server(user, %{"name" => "Server2"})

      servers = Servers.list_user_servers(user)
      assert length(servers) == 2
    end

    test "does not return servers user is not in" do
      user1 = create_user()
      user2 = create_user()
      create_server(user1)

      assert Servers.list_user_servers(user2) == []
    end
  end

  describe "join_server/2" do
    test "joins a server by invite code" do
      owner = create_user()
      server = create_server(owner)
      joiner = create_user()

      {:ok, joined} = Servers.join_server(joiner, server.invite_code)
      assert joined.id == server.id
      assert Servers.user_is_member?(joiner.id, server.id)
    end

    test "returns existing server if already member" do
      owner = create_user()
      server = create_server(owner)

      {:ok, same} = Servers.join_server(owner, server.invite_code)
      assert same.id == server.id
    end

    test "returns error for invalid invite code" do
      assert {:error, :not_found} = Servers.join_server(create_user(), "INVALID")
    end
  end

  describe "kick_member/2" do
    test "removes a member" do
      owner = create_user()
      server = create_server(owner)
      member = create_user()
      Servers.join_server(member, server.invite_code)

      {:ok, _} = Servers.kick_member(server.id, member.id)
      refute Servers.user_is_member?(member.id, server.id)
    end

    test "returns error for non-member" do
      owner = create_user()
      server = create_server(owner)
      assert {:error, :not_found} = Servers.kick_member(server.id, Ecto.UUID.generate())
    end
  end

  describe "channels" do
    test "create_channel adds a channel to a server" do
      owner = create_user()
      server = create_server(owner)

      {:ok, channel} =
        Servers.create_channel(server.id, %{"name" => "new-channel", "type" => "text"})

      assert channel.name == "new-channel"
      assert channel.server_id == server.id
    end

    test "delete_channel removes a channel" do
      owner = create_user()
      server = create_server(owner)
      channel = create_channel(server.id)

      {:ok, _} = Servers.delete_channel(channel)
      assert is_nil(Servers.get_channel(channel.id))
    end
  end

  describe "user_role/2" do
    test "returns owner role for server creator" do
      owner = create_user()
      server = create_server(owner)
      assert Servers.user_role(owner.id, server.id) == "owner"
    end

    test "returns member role for joined user" do
      owner = create_user()
      server = create_server(owner)
      member = create_user()
      Servers.join_server(member, server.invite_code)

      assert Servers.user_role(member.id, server.id) == "member"
    end

    test "returns nil for non-member" do
      owner = create_user()
      server = create_server(owner)
      assert is_nil(Servers.user_role(create_user().id, server.id))
    end
  end
end
