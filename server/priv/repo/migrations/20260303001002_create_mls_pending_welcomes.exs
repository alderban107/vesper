defmodule Vesper.Repo.Migrations.CreateMlsPendingWelcomes do
  use Ecto.Migration

  def change do
    create table(:mls_pending_welcomes, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :recipient_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :binary_id, on_delete: :delete_all)
      add :welcome_data, :binary, null: false
      add :sender_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:mls_pending_welcomes, [:recipient_id])
    create index(:mls_pending_welcomes, [:recipient_id, :channel_id])
  end
end
