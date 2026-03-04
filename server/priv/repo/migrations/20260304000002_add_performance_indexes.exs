defmodule Vesper.Repo.Migrations.AddPerformanceIndexes do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def change do
    # Composite index for channel unread count queries:
    # WHERE channel_id = ? AND sender_id != ? AND inserted_at > ?
    create index(:messages, [:channel_id, :sender_id, :inserted_at], concurrently: true)

    # Composite index for DM unread count queries:
    # WHERE conversation_id = ? AND sender_id != ? AND inserted_at > ?
    create index(:messages, [:conversation_id, :sender_id, :inserted_at], concurrently: true)

    # Index for messages.sender_id — used in unread WHERE clauses and sender preloads
    create index(:messages, [:sender_id], concurrently: true)

    # Index for member_roles.role_id — used in permission JOIN lookups
    create index(:member_roles, [:role_id], concurrently: true)

    # Index for messages.parent_message_id — used in thread queries
    create index(:messages, [:parent_message_id], concurrently: true)
  end
end
