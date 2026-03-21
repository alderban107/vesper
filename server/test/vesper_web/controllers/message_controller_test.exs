defmodule VesperWeb.MessageControllerTest do
  use VesperWeb.ConnCase, async: true

  import Vesper.Factory

  describe "GET /api/v1/channels/:id/messages" do
    test "lists channel messages", %{conn: conn} do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, channel_id: channel.id, sender_id: user.id})
      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, channel_id: channel.id, sender_id: user.id})

      conn =
        conn |> authenticated_conn(user) |> get("/api/v1/channels/#{channel.id}/messages")

      assert %{"messages" => messages} = json_response(conn, 200)
      assert length(messages) == 2
    end

    test "supports limit parameter", %{conn: conn} do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      for i <- 1..5 do
        create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, channel_id: channel.id, sender_id: user.id})
      end

      conn =
        conn
        |> authenticated_conn(user)
        |> get("/api/v1/channels/#{channel.id}/messages?limit=2")

      assert %{"messages" => messages} = json_response(conn, 200)
      assert length(messages) == 2
    end

    test "rejects non-member", %{conn: conn} do
      owner = create_user()
      server = create_server(owner)
      channel = hd(server.channels)
      other = create_user()

      conn =
        conn |> authenticated_conn(other) |> get("/api/v1/channels/#{channel.id}/messages")

      assert json_response(conn, 403)
    end

    test "includes encrypted message fields", %{conn: conn} do
      user = create_user()
      server = create_server(user)
      channel = hd(server.channels)

      create_message(%{
        ciphertext: :crypto.strong_rand_bytes(64),
        mls_epoch: 5,
        channel_id: channel.id,
        sender_id: user.id
      })

      conn =
        conn |> authenticated_conn(user) |> get("/api/v1/channels/#{channel.id}/messages")

      assert %{"messages" => [msg]} = json_response(conn, 200)
      assert msg["ciphertext"]
      assert msg["mls_epoch"] == 5
      refute Map.has_key?(msg, "content")
    end
  end
end
