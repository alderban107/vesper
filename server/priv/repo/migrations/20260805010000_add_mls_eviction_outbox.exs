defmodule Vesper.Repo.Migrations.AddMlsEvictionOutbox do
  use Ecto.Migration

  def change do
    create table(:mls_eviction_outbox, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :scope_kind, :string, null: false
      add :scope_id, :string, null: false
      add :group_id, :string, null: false
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all)

      add :target_user_id, references(:users, type: :binary_id, on_delete: :delete_all),
        null: false

      add :device_id, references(:devices, type: :binary_id, on_delete: :restrict), null: false
      add :target_device_id, :string, null: false
      add :cause, :string, null: false
      add :status, :string, null: false, default: "pending"
      add :reason, :string
      add :attempt_count, :integer, null: false, default: 0
      add :last_error, :text
      add :handed_off_at, :utc_datetime
      add :cancelled_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create index(:mls_eviction_outbox, [:status, :inserted_at])

    create unique_index(
             :mls_eviction_outbox,
             [:server_id, :target_user_id, :target_device_id, :scope_kind, :scope_id],
             name: :mls_eviction_outbox_active_scope_device_index,
             where: "status IN ('pending', 'handed_off')"
           )
  end
end
