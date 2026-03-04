defmodule Vesper.Repo.Migrations.CreateDmParticipants do
  use Ecto.Migration

  def change do
    create table(:dm_participants, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all), null: false

      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      add :joined_at, :utc_datetime, null: false, default: fragment("now()")
    end

    create unique_index(:dm_participants, [:conversation_id, :user_id])
    create index(:dm_participants, [:user_id])
  end
end
