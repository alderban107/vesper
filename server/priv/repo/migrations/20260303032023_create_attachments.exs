defmodule Vesper.Repo.Migrations.CreateAttachments do
  use Ecto.Migration

  def change do
    create table(:attachments, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :message_id, references(:messages, type: :binary_id, on_delete: :delete_all)
      add :filename, :string, null: false
      add :content_type, :string
      add :size_bytes, :bigint
      add :storage_key, :string, null: false

      add :inserted_at, :utc_datetime, null: false, default: fragment("now()")
    end

    create index(:attachments, [:message_id])
  end
end
