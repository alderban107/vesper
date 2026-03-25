defmodule Vesper.AccountsTest do
  use Vesper.DataCase, async: true

  alias Vesper.Accounts

  # ---------------------------------------------------------------------------
  # register_user/1
  # ---------------------------------------------------------------------------
  describe "register_user/1" do
    test "creates a user with valid attributes" do
      assert {:ok, user} =
               Accounts.register_user(%{
                 username: "alice",
                 password: "supersecret"
               })

      assert user.username == "alice"
      assert user.password_hash != nil
      # virtual password field is not persisted
      assert is_nil(Repo.get!(Vesper.Accounts.User, user.id).password)
    end

    test "rejects a duplicate username" do
      attrs = %{username: "bob", password: "supersecret"}
      assert {:ok, _} = Accounts.register_user(attrs)
      assert {:error, changeset} = Accounts.register_user(attrs)
      assert {"has already been taken", _} = changeset.errors[:username]
    end

    test "rejects a short password" do
      assert {:error, changeset} =
               Accounts.register_user(%{username: "carol", password: "short"})

      assert changeset.errors[:password] != nil
    end
  end

  # ---------------------------------------------------------------------------
  # authenticate_user/2
  # ---------------------------------------------------------------------------
  describe "authenticate_user/2" do
    setup do
      {:ok, user} =
        Accounts.register_user(%{username: "auth_user", password: "correcthorse"})

      %{user: user}
    end

    test "succeeds with correct password", %{user: user} do
      assert {:ok, authed} = Accounts.authenticate_user("auth_user", "correcthorse")
      assert authed.id == user.id
    end

    test "fails with wrong password" do
      assert {:error, :unauthorized} = Accounts.authenticate_user("auth_user", "wrongpassword")
    end

    test "fails for a nonexistent user" do
      assert {:error, :unauthorized} = Accounts.authenticate_user("ghost", "whatever1")
    end
  end

  # ---------------------------------------------------------------------------
  # ensure_device/4
  # ---------------------------------------------------------------------------
  describe "ensure_device/4" do
    setup do
      {:ok, user} =
        Accounts.register_user(%{username: "device_user", password: "password123"})

      %{user: user}
    end

    test "creates a new device when none exists for the client_id", %{user: user} do
      attrs = [client_id: "desktop-1", name: "My Laptop", platform: "linux"]

      assert {:ok, device} = Accounts.ensure_device(user, attrs, "trusted")
      assert device.client_id == "desktop-1"
      assert device.trust_state == "trusted"
      assert device.user_id == user.id
    end

    test "returns the existing device for the same client_id", %{user: user} do
      attrs = [client_id: "desktop-1", name: "My Laptop", platform: "linux"]

      {:ok, first} = Accounts.ensure_device(user, attrs, "trusted")
      {:ok, second} = Accounts.ensure_device(user, attrs, "trusted")
      assert first.id == second.id
    end
  end

  # ---------------------------------------------------------------------------
  # create_tokens/2 and refresh_tokens/1
  # ---------------------------------------------------------------------------
  describe "token lifecycle" do
    setup do
      {:ok, user} =
        Accounts.register_user(%{username: "token_user", password: "password123"})

      device = insert_device(user)
      %{user: user, device: device}
    end

    test "create_tokens/2 returns access and refresh tokens", %{user: user, device: device} do
      assert {:ok, tokens} = Accounts.create_tokens(user, device)
      assert is_binary(tokens.access_token)
      assert is_binary(tokens.refresh_token)
      assert tokens.expires_in == Vesper.Accounts.Token.access_token_ttl()
      assert tokens.current_device.id == device.id
    end

    test "refresh_tokens/1 rotates to new tokens", %{user: user, device: device} do
      {:ok, original} = Accounts.create_tokens(user, device)
      {:ok, refreshed} = Accounts.refresh_tokens(original.refresh_token)

      assert refreshed.access_token != original.access_token
      assert refreshed.refresh_token != original.refresh_token
    end

    test "refresh_tokens/1 rejects an already-used refresh token", %{
      user: user,
      device: device
    } do
      {:ok, original} = Accounts.create_tokens(user, device)

      # First refresh succeeds
      assert {:ok, _} = Accounts.refresh_tokens(original.refresh_token)

      # Second use of the same token fails (it was deleted during rotation)
      assert {:error, :invalid_token} = Accounts.refresh_tokens(original.refresh_token)
    end

    test "refresh_tokens/1 rejects garbage input" do
      assert {:error, :invalid_token} = Accounts.refresh_tokens("not-valid-base64!!!")
    end
  end
end
