defmodule VesperWeb.ServerControllerTest do
  use VesperWeb.ConnCase, async: true

  import Vesper.Factory

  describe "GET /api/v1/servers" do
    test "lists user's servers", %{conn: conn} do
      user = create_user()
      create_server(user, %{"name" => "Server1"})
      create_server(user, %{"name" => "Server2"})

      conn = conn |> authenticated_conn(user) |> get("/api/v1/servers")
      assert %{"servers" => servers} = json_response(conn, 200)
      assert length(servers) == 2
    end
  end

  describe "POST /api/v1/servers" do
    test "creates a server", %{conn: conn} do
      user = create_user()

      conn =
        conn
        |> authenticated_conn(user)
        |> post("/api/v1/servers", %{name: "New Server"})

      assert %{"server" => %{"name" => "New Server", "channels" => [_]}} =
               json_response(conn, 201)
    end
  end

  describe "GET /api/v1/servers/:id" do
    test "shows a server the user belongs to", %{conn: conn} do
      user = create_user()
      server = create_server(user)

      conn = conn |> authenticated_conn(user) |> get("/api/v1/servers/#{server.id}")
      assert %{"server" => %{"id" => _}} = json_response(conn, 200)
    end

    test "rejects non-member", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      other = create_user()

      conn = conn |> authenticated_conn(other) |> get("/api/v1/servers/#{server.id}")
      assert json_response(conn, 403)
    end
  end

  describe "DELETE /api/v1/servers/:id" do
    test "owner can delete server", %{conn: conn} do
      user = create_user()
      server = create_server(user)

      conn = conn |> authenticated_conn(user) |> delete("/api/v1/servers/#{server.id}")
      assert %{"ok" => true} = json_response(conn, 200)
    end

    test "non-owner cannot delete server", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      member = create_user()
      Vesper.Servers.join_server(member, server.invite_code)

      conn = conn |> authenticated_conn(member) |> delete("/api/v1/servers/#{server.id}")
      assert json_response(conn, 403)
    end
  end

  describe "POST /api/v1/servers/join" do
    test "joins a server by invite code", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      member = create_user()

      conn =
        conn
        |> authenticated_conn(member)
        |> post("/api/v1/servers/join", %{invite_code: server.invite_code})

      assert %{"server" => %{"id" => id}} = json_response(conn, 200)
      assert id == server.id
    end

    test "returns error for invalid invite code", %{conn: conn} do
      user = create_user()

      conn =
        conn
        |> authenticated_conn(user)
        |> post("/api/v1/servers/join", %{invite_code: "INVALID"})

      assert json_response(conn, 404)
    end
  end

  describe "GET /api/v1/servers/:server_id/members" do
    test "lists server members", %{conn: conn} do
      user = create_user()
      server = create_server(user)

      conn =
        conn |> authenticated_conn(user) |> get("/api/v1/servers/#{server.id}/members")

      assert %{"members" => members} = json_response(conn, 200)
      assert length(members) == 1
    end
  end

  describe "DELETE /api/v1/servers/:server_id/members/:user_id (kick)" do
    test "owner can kick a member", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      member = create_user()
      Vesper.Servers.join_server(member, server.invite_code)

      conn =
        conn
        |> authenticated_conn(owner)
        |> delete("/api/v1/servers/#{server.id}/members/#{member.id}")

      assert %{"ok" => true} = json_response(conn, 200)
    end

    test "non-admin cannot kick", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      member = create_user()
      Vesper.Servers.join_server(member, server.invite_code)

      conn =
        conn
        |> authenticated_conn(member)
        |> delete("/api/v1/servers/#{server.id}/members/#{owner.id}")

      assert json_response(conn, 403)
    end
  end
end
