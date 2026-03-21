defmodule Vesper.Repo.Migrations.DropMlsTables do
  use Ecto.Migration

  @moduledoc """
  Drop MLS-specific tables as part of the migration from MLS to Signal Protocol.

  MLS required server-side state for group management (pending welcomes, durable
  events, resync requests, history bundles, crypto evictions). Signal Protocol
  uses pre-key bundles for fully async session establishment — the server is just
  a key directory and ciphertext relay.

  The key_packages table is retained — it serves the same role for Signal Protocol
  pre-key bundles as it did for MLS key packages.
  """

  def up do
    drop_if_exists table(:mls_events)
    drop_if_exists table(:mls_pending_crypto_evictions)
    drop_if_exists table(:mls_pending_history_bundles)
    drop_if_exists table(:mls_pending_history_requests)
    drop_if_exists table(:mls_pending_resync_requests)
    drop_if_exists table(:mls_pending_welcomes)
  end

  def down do
    # Recreate MLS tables for rollback
    create table(:mls_pending_welcomes, primary_key: false) do
      add :id, :uuid, primary_key: true, default: fragment("gen_random_uuid()")
      add :recipient_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :recipient_client_id, :string
      add :recipient_key_package_ref, :text
      add :group_id, :string
      add :channel_id, references(:channels, type: :uuid, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :uuid, on_delete: :delete_all)
      add :welcome_data, :binary, null: false
      add :sender_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      timestamps(type: :utc_datetime)
    end

    create index(:mls_pending_welcomes, [:recipient_id, :group_id],
      name: :mls_pending_welcomes_scope_unique_index
    )

    create table(:mls_events, primary_key: false) do
      add :id, :bigserial, primary_key: true
      add :group_id, :string, null: false
      add :event_type, :string, null: false
      add :payload, :map, default: %{}
      add :sender_id, references(:users, type: :uuid, on_delete: :nilify_all)
      add :sender_device_id, :string
      add :channel_id, references(:channels, type: :uuid, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :uuid, on_delete: :delete_all)
      timestamps(type: :utc_datetime)
    end

    create index(:mls_events, [:group_id, :id])

    create table(:mls_pending_resync_requests, primary_key: false) do
      add :id, :uuid, primary_key: true, default: fragment("gen_random_uuid()")
      add :group_id, :string, null: false
      add :request_id, :string, null: false
      add :requester_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :requester_client_id, :string
      add :requester_username, :string
      add :last_known_epoch, :integer
      add :reason, :string
      add :channel_id, references(:channels, type: :uuid, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :uuid, on_delete: :delete_all)
      timestamps(type: :utc_datetime)
    end

    create index(:mls_pending_resync_requests, [:group_id])

    create table(:mls_pending_history_requests, primary_key: false) do
      add :id, :uuid, primary_key: true, default: fragment("gen_random_uuid()")
      add :group_id, :string, null: false
      add :requester_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :requester_client_id, :string
      add :requester_username, :string
      add :channel_id, references(:channels, type: :uuid, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :uuid, on_delete: :delete_all)
      timestamps(type: :utc_datetime)
    end

    create table(:mls_pending_history_bundles, primary_key: false) do
      add :id, :uuid, primary_key: true, default: fragment("gen_random_uuid()")
      add :group_id, :string, null: false
      add :ciphertext, :string, null: false
      add :mls_epoch, :integer
      add :recipient_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :recipient_client_id, :string
      add :sender_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :channel_id, references(:channels, type: :uuid, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :uuid, on_delete: :delete_all)
      timestamps(type: :utc_datetime)
    end

    create table(:mls_pending_crypto_evictions, primary_key: false) do
      add :id, :uuid, primary_key: true, default: fragment("gen_random_uuid()")
      add :scope_kind, :string, null: false
      add :scope_id, :string, null: false
      add :group_id, :string, null: false
      add :server_id, references(:servers, type: :uuid, on_delete: :delete_all)
      add :target_user_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :target_device_id, :string
      add :status, :string, null: false, default: "pending"
      add :reason, :string
      add :attempt_count, :integer, null: false, default: 0
      add :sponsor_user_id, references(:users, type: :uuid, on_delete: :nilify_all)
      add :sponsor_device_id, :string
      add :requested_at, :utc_datetime
      add :claimed_at, :utc_datetime
      add :committed_at, :utc_datetime
      add :applied_at, :utc_datetime
      add :commit_event_id, :bigint
      timestamps(type: :utc_datetime)
    end
  end
end
