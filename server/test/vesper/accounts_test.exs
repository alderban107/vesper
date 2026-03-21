defmodule Vesper.AccountsTest do
  use Vesper.DataCase, async: true

  alias Vesper.Accounts
  import Vesper.Factory

  describe "register_user/1" do
    test "creates a user with valid attrs" do
      {:ok, user} = Accounts.register_user(%{username: "testuser", password: "password123!"})
      assert user.username == "testuser"
      assert user.id
    end

    test "rejects duplicate username" do
      create_user(%{username: "taken"})
      {:error, changeset} = Accounts.register_user(%{username: "taken", password: "password123!"})
      assert errors_on(changeset).username
    end

    test "rejects short password" do
      {:error, changeset} = Accounts.register_user(%{username: "shortpw", password: "short"})
      assert errors_on(changeset).password
    end

    test "rejects short username" do
      {:error, changeset} = Accounts.register_user(%{username: "x", password: "password123!"})
      assert errors_on(changeset).username
    end
  end

  describe "authenticate_user/2" do
    test "succeeds with correct password" do
      create_user(%{username: "authtst", password: "password123!"})
      assert {:ok, user} = Accounts.authenticate_user("authtst", "password123!")
      assert user.username == "authtst"
    end

    test "fails with wrong password" do
      create_user(%{username: "authtst2", password: "password123!"})
      assert {:error, :unauthorized} = Accounts.authenticate_user("authtst2", "wrong")
    end

    test "fails with nonexistent user" do
      assert {:error, :unauthorized} = Accounts.authenticate_user("nobody", "password123!")
    end
  end

  describe "tokens" do
    test "create_tokens returns access and refresh tokens" do
      user = create_user()
      {:ok, tokens} = Accounts.create_tokens(user)
      assert tokens.access_token
      assert tokens.refresh_token
      assert tokens.expires_in
    end

    test "refresh_tokens rotates tokens" do
      user = create_user()
      {:ok, tokens} = Accounts.create_tokens(user)
      {:ok, new_tokens} = Accounts.refresh_tokens(tokens.refresh_token)
      assert new_tokens.access_token != tokens.access_token
      assert new_tokens.refresh_token != tokens.refresh_token
    end

    test "refresh_tokens rejects invalid token" do
      assert {:error, :invalid_token} = Accounts.refresh_tokens("invalid")
    end

    test "revoke_refresh_token deletes the token" do
      user = create_user()
      {:ok, tokens} = Accounts.create_tokens(user)
      :ok = Accounts.revoke_refresh_token(tokens.refresh_token)
      assert {:error, :invalid_token} = Accounts.refresh_tokens(tokens.refresh_token)
    end
  end

  describe "key_bundle" do
    test "update_key_bundle stores encrypted bundle" do
      user = create_user()
      bundle = :crypto.strong_rand_bytes(32)
      salt = :crypto.strong_rand_bytes(16)
      nonce = :crypto.strong_rand_bytes(12)

      {:ok, updated} =
        Accounts.update_key_bundle(user, %{
          encrypted_key_bundle: bundle,
          key_bundle_salt: salt,
          key_bundle_nonce: nonce
        })

      assert updated.encrypted_key_bundle == bundle
    end
  end

  describe "recovery" do
    test "verify_recovery_key finds user by hash" do
      user = create_user()
      hash = "recovery_hash_#{System.unique_integer([:positive])}"

      Accounts.update_key_bundle(user, %{recovery_key_hash: hash})
      assert {:ok, found} = Accounts.verify_recovery_key(hash)
      assert found.id == user.id
    end

    test "verify_recovery_key returns error for unknown hash" do
      assert {:error, :not_found} = Accounts.verify_recovery_key("unknown")
    end
  end
end
