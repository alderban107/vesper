defmodule Vesper.Repo.Migrations.AddThreadAndReplyFieldsToMessages do
  use Ecto.Migration

  def change do
    alter table(:messages) do
      add :thread_root_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
      add :reply_to_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:messages, [:thread_root_message_id])

    create index(:messages, [:thread_root_message_id, :inserted_at, :id],
             name: :messages_thread_root_inserted_at_id_idx
           )

    create index(:messages, [:reply_to_message_id])
  end
end
