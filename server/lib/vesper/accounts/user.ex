defmodule Vesper.Accounts.User do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field :username, :string
    field :display_name, :string
    field :password_hash, :string
    field :password, :string, virtual: true, redact: true

    # Crypto fields (Phase 2)
    field :encrypted_key_bundle, :binary
    field :key_bundle_salt, :binary
    field :key_bundle_nonce, :binary
    field :public_identity_key, :binary
    field :public_key_exchange, :binary
    field :recovery_key_hash, :string
    field :encrypted_recovery_bundle, :binary

    field :avatar_url, :string
    field :status, :string, default: "offline"

    has_many :memberships, Vesper.Servers.Membership
    has_many :servers, through: [:memberships, :server]

    timestamps(type: :utc_datetime)
  end

  def registration_changeset(user, attrs) do
    user
    |> cast(attrs, [:username, :display_name, :password])
    |> validate_username()
    |> validate_password()
    |> hash_password()
  end

  defp validate_username(changeset) do
    changeset
    |> validate_required([:username])
    |> validate_length(:username, min: 2, max: 32)
    |> validate_format(:username, ~r/^[a-zA-Z0-9_]+$/,
      message: "must be alphanumeric with underscores"
    )
    |> unsafe_validate_unique(:username, Vesper.Repo)
    |> unique_constraint(:username)
  end

  defp validate_password(changeset) do
    changeset
    |> validate_required([:password])
    |> validate_length(:password, min: 8, max: 128)
  end

  defp hash_password(changeset) do
    case changeset do
      %Ecto.Changeset{valid?: true, changes: %{password: password}} ->
        put_change(changeset, :password_hash, Argon2.hash_pwd_salt(password))

      _ ->
        changeset
    end
  end

  def verify_password(%__MODULE__{password_hash: hash}, password)
      when is_binary(hash) and is_binary(password) do
    Argon2.verify_pass(password, hash)
  end

  def verify_password(_, _), do: Argon2.no_user_verify()

  def profile_changeset(user, attrs) do
    user
    |> cast(attrs, [:display_name, :avatar_url, :status])
    |> validate_inclusion(:status, ~w(online idle dnd offline))
  end

  @crypto_fields [
    :encrypted_key_bundle,
    :key_bundle_salt,
    :key_bundle_nonce,
    :public_identity_key,
    :public_key_exchange,
    :recovery_key_hash,
    :encrypted_recovery_bundle
  ]

  def crypto_changeset(user, attrs) do
    user
    |> cast(attrs, @crypto_fields)
  end
end
