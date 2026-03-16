defmodule Vesper.Repo.Migrations.AddPendingHistoryRecoveryTables do
  use Ecto.Migration

  def change do
    create table(:mls_pending_history_requests, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :group_id, :string, null: false
      add :requester_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :requester_client_id, :string, null: false
      add :requester_username, :string
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create unique_index(
             :mls_pending_history_requests,
             [:group_id, :requester_id, :requester_client_id],
             name: :mls_pending_history_requests_group_id_requester_id_requester_client_id_index
           )

    create index(:mls_pending_history_requests, [:group_id])

    create table(:mls_pending_history_bundles, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :group_id, :string, null: false
      add :ciphertext, :text, null: false
      add :mls_epoch, :integer, null: false
      add :recipient_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :recipient_client_id, :string, null: false
      add :sender_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create unique_index(
             :mls_pending_history_bundles,
             [:group_id, :recipient_id, :recipient_client_id, :sender_id],
             name: :mls_pending_history_bundles_group_recipient_sender_index
           )

    create index(:mls_pending_history_bundles, [:group_id])
    create index(:mls_pending_history_bundles, [:recipient_id, :recipient_client_id])
  end
end
