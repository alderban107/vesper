defmodule Vesper.Repo.Migrations.AddThreadsAndReactions do
  use Ecto.Migration

  def change do
    # Threads: parent message reference
    alter table(:messages) do
      add :parent_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:messages, [:parent_message_id])

    # Reactions table
    create table(:reactions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :message_id, references(:messages, type: :binary_id, on_delete: :delete_all),
        null: false

      add :sender_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :emoji, :string, size: 32, null: false
      add :ciphertext, :binary
      add :mls_epoch, :integer

      timestamps(type: :utc_datetime)
    end

    create unique_index(:reactions, [:message_id, :sender_id, :emoji])
    create index(:reactions, [:message_id])
  end
end
