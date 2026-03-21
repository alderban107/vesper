defmodule VesperWeb.AuthControllerTest do
  use VesperWeb.ConnCase, async: true

  import Vesper.Factory

  describe "POST /api/v1/auth/register" do
    test "registers a user", %{conn: conn} do
      conn =
        post(conn, "/api/v1/auth/register", %{
          username: "newuser",
          password: "password123!"
        })

      assert %{"user" => %{"username" => "newuser"}, "access_token" => _} = json_response(conn, 201)
    end

    test "rejects duplicate username", %{conn: conn} do
      create_user(%{username: "taken"})

      conn =
        post(conn, "/api/v1/auth/register", %{
          username: "taken",
          password: "password123!"
        })

      assert %{"errors" => _} = json_response(conn, 422)
    end

    test "rejects missing fields", %{conn: conn} do
      conn = post(conn, "/api/v1/auth/register", %{})
      assert json_response(conn, 400)
    end
  end

  describe "POST /api/v1/auth/login" do
    test "logs in with correct credentials", %{conn: conn} do
      create_user(%{username: "logintest", password: "password123!"})

      conn =
        post(conn, "/api/v1/auth/login", %{
          username: "logintest",
          password: "password123!"
        })

      assert %{"user" => %{"username" => "logintest"}, "access_token" => _} =
               json_response(conn, 200)
    end

    test "rejects wrong password", %{conn: conn} do
      create_user(%{username: "logintest2", password: "password123!"})

      conn =
        post(conn, "/api/v1/auth/login", %{
          username: "logintest2",
          password: "wrong"
        })

      assert %{"error" => _} = json_response(conn, 401)
    end
  end

  describe "POST /api/v1/auth/refresh" do
    test "refreshes tokens", %{conn: conn} do
      user = create_user()
      {:ok, tokens} = Vesper.Accounts.create_tokens(user)

      conn = post(conn, "/api/v1/auth/refresh", %{refresh_token: tokens.refresh_token})

      assert %{"access_token" => _, "refresh_token" => _} = json_response(conn, 200)
    end

    test "rejects invalid refresh token", %{conn: conn} do
      conn = post(conn, "/api/v1/auth/refresh", %{refresh_token: "invalid"})
      assert json_response(conn, 401)
    end
  end

  describe "POST /api/v1/auth/logout" do
    test "logs out successfully", %{conn: conn} do
      conn = post(conn, "/api/v1/auth/logout", %{})
      assert %{"ok" => true} = json_response(conn, 200)
    end
  end

  describe "GET /api/v1/auth/me" do
    test "returns current user", %{conn: conn} do
      user = create_user()
      conn = conn |> authenticated_conn(user) |> get("/api/v1/auth/me")

      assert %{"user" => %{"id" => id}} = json_response(conn, 200)
      assert id == user.id
    end

    test "rejects unauthenticated request", %{conn: conn} do
      conn = get(conn, "/api/v1/auth/me")
      assert json_response(conn, 401)
    end
  end

  describe "PUT /api/v1/auth/password" do
    test "changes password", %{conn: conn} do
      user = create_user(%{password: "oldpass123!"})

      conn =
        conn
        |> authenticated_conn(user)
        |> put("/api/v1/auth/password", %{
          old_password: "oldpass123!",
          new_password: "newpass456!"
        })

      assert %{"ok" => true} = json_response(conn, 200)
    end

    test "rejects wrong old password", %{conn: conn} do
      user = create_user(%{password: "correct123!"})

      conn =
        conn
        |> authenticated_conn(user)
        |> put("/api/v1/auth/password", %{
          old_password: "wrong",
          new_password: "newpass456!"
        })

      assert json_response(conn, 401)
    end
  end
end
