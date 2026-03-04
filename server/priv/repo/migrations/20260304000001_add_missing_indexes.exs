defmodule Vesper.Repo.Migrations.AddMissingIndexes do
  use Ecto.Migration

  def change do
    create index(:attachments, [:storage_key])
    create index(:dm_conversations, [:type])
  end
end
