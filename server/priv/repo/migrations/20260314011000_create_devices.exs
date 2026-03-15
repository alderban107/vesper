defmodule Vesper.Repo.Migrations.CreateDevices do
  use Ecto.Migration

  def change do
    create table(:devices, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :client_id, :string, size: 128, null: false
      add :name, :string, size: 160, null: false
      add :platform, :string, size: 64
      add :trust_state, :string, size: 16, null: false, default: "pending"
      add :approval_method, :string, size: 32
      add :trusted_at, :utc_datetime
      add :revoked_at, :utc_datetime
      add :last_seen_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create unique_index(:devices, [:user_id, :client_id])
    create index(:devices, [:user_id, :trust_state])

    alter table(:user_tokens) do
      add :device_id, references(:devices, type: :binary_id, on_delete: :delete_all)
    end

    create index(:user_tokens, [:device_id])
  end
end
