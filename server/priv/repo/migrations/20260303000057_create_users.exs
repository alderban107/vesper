defmodule Vesper.Repo.Migrations.CreateUsers do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :username, :string, size: 32, null: false
      add :display_name, :string, size: 64
      add :password_hash, :text, null: false

      # Crypto fields — nullable for Phase 1, populated in Phase 2
      add :encrypted_key_bundle, :binary
      add :key_bundle_salt, :binary
      add :key_bundle_nonce, :binary
      add :public_identity_key, :binary
      add :public_key_exchange, :binary
      add :recovery_key_hash, :text
      add :encrypted_recovery_bundle, :binary

      add :avatar_url, :text
      add :status, :string, size: 16, default: "offline"

      timestamps(type: :utc_datetime)
    end

    create unique_index(:users, [:username])
  end
end
