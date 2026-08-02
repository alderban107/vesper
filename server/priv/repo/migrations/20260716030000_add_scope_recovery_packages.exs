defmodule Vesper.Repo.Migrations.AddScopeRecoveryPackages do
  use Ecto.Migration

  def change do
    create table(:scope_recovery_packages, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :scope_id, :string, null: false
      add :owner_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :ciphertext, :text, null: false
      add :nonce, :binary, null: false
      add :membership_generation, :integer, null: false
      add :last_event_seq, :integer, null: false, default: 0
      add :schema_version, :integer, null: false, default: 1
      add :byte_size, :integer, null: false
      add :expires_at, :utc_datetime, null: false
      timestamps(type: :utc_datetime)
    end

    create unique_index(:scope_recovery_packages, [:scope_id, :owner_id])
    create index(:scope_recovery_packages, [:owner_id, :expires_at])
  end
end
