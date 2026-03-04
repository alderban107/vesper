defmodule Vesper.Repo.Migrations.CreateReadPositions do
  use Ecto.Migration

  def change do
    create table(:channel_read_positions, primary_key: false) do
      add :id, :binary_id, primary_key: true, default: fragment("gen_random_uuid()")
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all),
        null: false

      add :last_read_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
      add :last_read_at, :utc_datetime, default: fragment("NOW()")
    end

    create unique_index(:channel_read_positions, [:user_id, :channel_id])

    create table(:dm_read_positions, primary_key: false) do
      add :id, :binary_id, primary_key: true, default: fragment("gen_random_uuid()")
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all), null: false

      add :last_read_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
      add :last_read_at, :utc_datetime, default: fragment("NOW()")
    end

    create unique_index(:dm_read_positions, [:user_id, :conversation_id])
  end
end
