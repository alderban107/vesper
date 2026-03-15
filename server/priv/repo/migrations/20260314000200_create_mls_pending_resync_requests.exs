defmodule Vesper.Repo.Migrations.CreateMlsPendingResyncRequests do
  use Ecto.Migration

  def change do
    create table(:mls_pending_resync_requests, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :group_id, :string, null: false
      add :request_id, :string, null: false
      add :requester_username, :string
      add :last_known_epoch, :integer
      add :reason, :string
      add :requester_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:mls_pending_resync_requests, [:group_id])
    create index(:mls_pending_resync_requests, [:requester_id])
    create unique_index(:mls_pending_resync_requests, [:group_id, :requester_id])
  end
end
