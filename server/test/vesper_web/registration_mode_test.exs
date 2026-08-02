defmodule VesperWeb.RegistrationModeTest do
  use Vesper.ConnCase, async: false

  alias Vesper.Accounts

  setup do
    previous_mode = Application.get_env(:vesper, :registration_mode)
    previous_secret = Application.get_env(:vesper, :registration_invite_secret)

    on_exit(fn ->
      Application.put_env(:vesper, :registration_mode, previous_mode)
      Application.put_env(:vesper, :registration_invite_secret, previous_secret)
    end)

    :ok
  end

  test "open mode permits direct REST registration", %{conn: conn} do
    Application.put_env(:vesper, :registration_mode, :open)
    username = unique_username("open")

    response = post(conn, "/api/v1/auth/register", registration_params(username))

    assert %{"user" => %{"username" => ^username}} = json_response(response, 201)
    assert Accounts.get_user_by_username(username)
  end

  test "closed mode rejects direct REST registration before creating an account", %{conn: conn} do
    Application.put_env(:vesper, :registration_mode, :closed)
    username = unique_username("closed")

    response = post(conn, "/api/v1/auth/register", registration_params(username))

    assert %{"error" => "registration is closed"} = json_response(response, 403)
    refute Accounts.get_user_by_username(username)
  end

  test "invite-only mode requires the configured secret", %{conn: conn} do
    Application.put_env(:vesper, :registration_mode, :invite_only)
    Application.put_env(:vesper, :registration_invite_secret, "registration-secret-123")
    rejected_username = unique_username("rejected")

    rejected =
      post(conn, "/api/v1/auth/register", registration_params(rejected_username))

    assert %{"error" => "a valid registration invite is required"} =
             json_response(rejected, 403)

    refute Accounts.get_user_by_username(rejected_username)

    accepted_username = unique_username("accepted")

    accepted =
      post(
        Phoenix.ConnTest.build_conn(),
        "/api/v1/auth/register",
        registration_params(accepted_username, "registration-secret-123")
      )

    assert %{"user" => %{"username" => ^accepted_username}} = json_response(accepted, 201)
  end

  defp registration_params(username, invite \\ nil) do
    %{
      "username" => username,
      "password" => "registration-test-password",
      "device_id" => Ecto.UUID.generate(),
      "device_name" => "Registration test",
      "device_platform" => "test"
    }
    |> then(fn params ->
      if invite, do: Map.put(params, "registration_invite", invite), else: params
    end)
  end

  defp unique_username(prefix),
    do: "registration_#{prefix}_#{System.unique_integer([:positive])}"
end
