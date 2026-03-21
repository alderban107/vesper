defmodule VesperWeb.ConversationControllerTest do
  use VesperWeb.ConnCase, async: true

  import Vesper.Factory

  describe "POST /api/v1/conversations" do
    test "creates a DM conversation", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()

      conn =
        conn
        |> authenticated_conn(user1)
        |> post("/api/v1/conversations", %{participant_ids: [user2.id]})

      assert %{"conversation" => conv} = json_response(conn, 201)
      assert conv["type"] == "direct"
      assert length(conv["participants"]) == 2
    end

    test "returns existing conversation for duplicate direct DM", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()

      conn1 =
        conn
        |> authenticated_conn(user1)
        |> post("/api/v1/conversations", %{participant_ids: [user2.id]})

      %{"conversation" => conv1} = json_response(conn1, 201)

      conn2 =
        build_conn()
        |> authenticated_conn(user1)
        |> post("/api/v1/conversations", %{participant_ids: [user2.id]})

      %{"conversation" => conv2} = json_response(conn2, 201)
      assert conv1["id"] == conv2["id"]
    end

    test "creates a group conversation with name", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()

      conn =
        conn
        |> authenticated_conn(user1)
        |> post("/api/v1/conversations", %{
          participant_ids: [user2.id, user3.id],
          name: "My Group"
        })

      assert %{"conversation" => conv} = json_response(conn, 201)
      assert conv["type"] == "group"
      assert conv["name"] == "My Group"
      assert length(conv["participants"]) == 3
    end

    test "rejects missing participant_ids", %{conn: conn} do
      user = create_user()
      conn = conn |> authenticated_conn(user) |> post("/api/v1/conversations", %{})
      assert json_response(conn, 400)
    end
  end

  describe "GET /api/v1/conversations" do
    test "lists user's conversations", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()

      create_conversation(user1.id, [user2.id])
      create_conversation(user1.id, [user3.id])

      conn = conn |> authenticated_conn(user1) |> get("/api/v1/conversations")

      assert %{"conversations" => convs} = json_response(conn, 200)
      assert length(convs) == 2
    end

    test "includes last_message when present", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, conversation_id: conv.id, sender_id: user1.id})

      conn = conn |> authenticated_conn(user1) |> get("/api/v1/conversations")
      %{"conversations" => [c]} = json_response(conn, 200)
      assert c["last_message"]["ciphertext"]
    end
  end

  describe "GET /api/v1/conversations/:id" do
    test "shows a conversation the user participates in", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      conn = conn |> authenticated_conn(user1) |> get("/api/v1/conversations/#{conv.id}")

      assert %{"conversation" => %{"id" => id}} = json_response(conn, 200)
      assert id == conv.id
    end

    test "rejects non-participant", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      conn = conn |> authenticated_conn(user3) |> get("/api/v1/conversations/#{conv.id}")
      assert json_response(conn, 403)
    end
  end

  describe "GET /api/v1/conversations/:conversation_id/messages" do
    test "lists conversation messages", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, conversation_id: conv.id, sender_id: user1.id})
      create_message(%{ciphertext: :crypto.strong_rand_bytes(64), mls_epoch: 1, conversation_id: conv.id, sender_id: user2.id})

      conn =
        conn
        |> authenticated_conn(user1)
        |> get("/api/v1/conversations/#{conv.id}/messages")

      assert %{"messages" => messages} = json_response(conn, 200)
      assert length(messages) == 2
    end

    test "rejects non-participant", %{conn: conn} do
      user1 = create_user()
      user2 = create_user()
      user3 = create_user()
      conv = create_conversation(user1.id, [user2.id])

      conn =
        conn
        |> authenticated_conn(user3)
        |> get("/api/v1/conversations/#{conv.id}/messages")

      assert json_response(conn, 403)
    end
  end
end
