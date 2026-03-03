defmodule Vesper.Repo.Migrations.UpdateAttachmentsForFileSharing do
  use Ecto.Migration

  def change do
    alter table(:attachments) do
      add :expires_at, :utc_datetime
      add :encrypted, :boolean, default: false
    end

    # Make message_id nullable (was NOT NULL from create_attachments)
    execute "ALTER TABLE attachments ALTER COLUMN message_id DROP NOT NULL",
            "ALTER TABLE attachments ALTER COLUMN message_id SET NOT NULL"

    create index(:attachments, [:expires_at])
  end
end
