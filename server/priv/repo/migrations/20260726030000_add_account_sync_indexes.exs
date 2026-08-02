defmodule Vesper.Repo.Migrations.AddAccountSyncIndexes do
  use Ecto.Migration

  def change do
    create index(:dm_participants, [:user_id, :conversation_id])
  end
end
