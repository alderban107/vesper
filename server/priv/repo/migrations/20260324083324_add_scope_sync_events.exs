defmodule Vesper.Repo.Migrations.AddScopeSyncEvents do
  use Ecto.Migration

  def change do
    create table(:scope_sync_events) do
      add :event_type, :string, null: false
      add :scope_kind, :string, null: false
      add :scope_id, :binary_id, null: false
      add :payload, :map, default: %{}
      add :inserted_at, :utc_datetime, null: false
    end

    create index(:scope_sync_events, [:scope_kind, :scope_id, :id])
    create index(:scope_sync_events, [:scope_id, :id])
  end
end
