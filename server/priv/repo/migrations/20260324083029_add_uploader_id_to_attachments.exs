defmodule Vesper.Repo.Migrations.AddUploaderIdToAttachments do
  use Ecto.Migration

  def change do
    alter table(:attachments) do
      add :uploader_id, references(:users, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:attachments, [:uploader_id])
  end
end
