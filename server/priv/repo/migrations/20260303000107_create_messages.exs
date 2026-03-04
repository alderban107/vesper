defmodule Vesper.Repo.Migrations.CreateMessages do
  use Ecto.Migration

  def change do
    create table(:messages, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      add :sender_id, references(:users, type: :binary_id, on_delete: :nilify_all)

      # Phase 1: plaintext content. Phase 2: this becomes ciphertext (binary)
      add :content, :text, null: false

      add :mls_epoch, :bigint
      add :expires_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create index(:messages, [:channel_id, :inserted_at])
    create index(:messages, [:conversation_id, :inserted_at])

    create index(:messages, [:expires_at],
             where: "expires_at IS NOT NULL",
             name: :idx_messages_expires
           )

    create constraint(:messages, :message_belongs_to_one_target,
             check: """
             (channel_id IS NOT NULL AND conversation_id IS NULL) OR
             (channel_id IS NULL AND conversation_id IS NOT NULL)
             """
           )
  end
end
