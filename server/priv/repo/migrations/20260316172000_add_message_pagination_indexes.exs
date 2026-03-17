defmodule Vesper.Repo.Migrations.AddMessagePaginationIndexes do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def change do
    create_if_not_exists index(:messages, [:channel_id, :inserted_at, :id], concurrently: true)

    create_if_not_exists index(:messages, [:conversation_id, :inserted_at, :id],
                           concurrently: true
                         )

    create_if_not_exists index(:messages, [:parent_message_id, :inserted_at, :id],
                           concurrently: true
                         )
  end
end
