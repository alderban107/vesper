defmodule Vesper.Repo.Migrations.AddPendingCryptoEvictions do
  use Ecto.Migration

  def change do
    create table(:mls_pending_crypto_evictions, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :scope_kind, :string, null: false
      add :scope_id, :string, null: false
      add :group_id, :string, null: false
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false

      add :target_user_id, references(:users, type: :binary_id, on_delete: :delete_all),
        null: false

      add :target_device_id, :string
      add :reason, :string
      add :status, :string, null: false, default: "pending"
      add :attempt_count, :integer, null: false, default: 0
      add :last_error, :text

      add :sponsor_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :sponsor_device_id, :string
      add :requested_at, :utc_datetime
      add :claimed_at, :utc_datetime
      add :committed_at, :utc_datetime
      add :applied_at, :utc_datetime

      add :commit_event_id, references(:mls_events, type: :id, on_delete: :nilify_all)

      timestamps(type: :utc_datetime)
    end

    create index(:mls_pending_crypto_evictions, [:scope_kind, :scope_id, :status])

    create index(:mls_pending_crypto_evictions, [:server_id, :status])

    create index(:mls_pending_crypto_evictions, [:target_user_id, :status])

    create index(:mls_pending_crypto_evictions, [:scope_kind, :scope_id, :inserted_at])
  end
end
