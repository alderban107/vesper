defmodule Vesper.Repo.Migrations.CreateDmConversations do
  use Ecto.Migration

  def change do
    create table(:dm_conversations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :type, :string, size: 8, null: false, default: "direct"
      add :name, :string, size: 100
      add :disappearing_ttl, :integer

      add :inserted_at, :utc_datetime, null: false, default: fragment("now()")
    end
  end
end
