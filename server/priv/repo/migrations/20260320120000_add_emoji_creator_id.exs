defmodule Vesper.Repo.Migrations.AddEmojiCreatorId do
  use Ecto.Migration

  def change do
    alter table(:server_emojis) do
      add :creator_id, references(:users, type: :binary_id, on_delete: :nilify_all), null: true
    end

    create index(:server_emojis, [:creator_id])
  end
end
