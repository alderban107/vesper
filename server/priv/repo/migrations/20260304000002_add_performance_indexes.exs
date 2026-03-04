defmodule Vesper.Repo.Migrations.AddPerformanceIndexes do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def change do
    # Composite index for channel unread count queries:
    # WHERE channel_id = ? AND sender_id != ? AND inserted_at > ?
    create_if_not_exists index(:messages, [:channel_id, :sender_id, :inserted_at],
                           concurrently: true
                         )

    # Composite index for DM unread count queries:
    # WHERE conversation_id = ? AND sender_id != ? AND inserted_at > ?
    create_if_not_exists index(:messages, [:conversation_id, :sender_id, :inserted_at],
                           concurrently: true
                         )

    # Index for messages.sender_id — used in unread WHERE clauses and sender preloads
    create_if_not_exists index(:messages, [:sender_id], concurrently: true)

    # Index for member_roles.role_id — used in permission JOIN lookups
    create_if_not_exists index(:member_roles, [:role_id], concurrently: true)

    # parent_message_id index already exists in 20260303032117_add_threads_and_reactions
  end
end
