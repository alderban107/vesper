defmodule VesperWeb.KeyPackageControllerTest do
  use VesperWeb.ConnCase, async: true

  import Vesper.Factory

  describe "POST /api/v1/key-packages" do
    test "uploads key packages", %{conn: conn} do
      user = create_user()
      packages = Enum.map(1..5, fn _ -> Base.encode64(:crypto.strong_rand_bytes(64)) end)

      conn =
        conn
        |> authenticated_conn(user)
        |> post("/api/v1/key-packages", %{key_packages: packages})

      assert %{"uploaded" => 5} = json_response(conn, 201)
    end

    test "rejects missing key_packages", %{conn: conn} do
      user = create_user()
      conn = conn |> authenticated_conn(user) |> post("/api/v1/key-packages", %{})
      assert json_response(conn, 400)
    end
  end

  describe "GET /api/v1/key-packages/me/count" do
    test "returns count of unconsumed packages", %{conn: conn} do
      user = create_user()
      upload_key_packages(user.id, 7)

      conn =
        conn |> authenticated_conn(user) |> get("/api/v1/key-packages/me/count")

      assert %{"count" => 7} = json_response(conn, 200)
    end
  end

  describe "GET /api/v1/key-packages/:user_id" do
    test "fetches and consumes a key package", %{conn: conn} do
      requester = create_user()
      target = create_user()
      upload_key_packages(target.id, 3)

      conn =
        conn
        |> authenticated_conn(requester)
        |> get("/api/v1/key-packages/#{target.id}")

      assert %{"key_package" => _} = json_response(conn, 200)

      # Count should decrease
      assert Vesper.Encryption.count_key_packages(target.id) == 2
    end

    test "returns 404 when no packages available", %{conn: conn} do
      requester = create_user()
      target = create_user()

      conn =
        conn
        |> authenticated_conn(requester)
        |> get("/api/v1/key-packages/#{target.id}")

      assert json_response(conn, 404)
    end
  end
end
