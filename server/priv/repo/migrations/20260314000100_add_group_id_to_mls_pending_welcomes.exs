defmodule Vesper.Repo.Migrations.AddGroupIdToMlsPendingWelcomes do
  use Ecto.Migration

  def up do
    alter table(:mls_pending_welcomes) do
      add :group_id, :string
    end

    execute("""
    UPDATE mls_pending_welcomes
    SET group_id = channel_id::text
    WHERE group_id IS NULL AND channel_id IS NOT NULL
    """)

    execute("""
    UPDATE mls_pending_welcomes
    SET group_id = conversation_id::text
    WHERE group_id IS NULL AND conversation_id IS NOT NULL
    """)

    create index(:mls_pending_welcomes, [:recipient_id, :group_id])
  end

  def down do
    drop index(:mls_pending_welcomes, [:recipient_id, :group_id])

    alter table(:mls_pending_welcomes) do
      remove :group_id
    end
  end
end
