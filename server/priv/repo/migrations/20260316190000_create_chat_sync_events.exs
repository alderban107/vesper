defmodule Vesper.Repo.Migrations.CreateChatSyncEvents do
  use Ecto.Migration

  def change do
    create table(:chat_sync_events, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :scope_kind, :string, null: false
      add :scope_id, :binary_id, null: false
      add :event_type, :string, null: false
      add :message_id, :binary_id
      add :payload, :map, null: false, default: %{}

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:chat_sync_events, [:scope_kind, :scope_id, :inserted_at])
    create index(:chat_sync_events, [:inserted_at])
  end
end
