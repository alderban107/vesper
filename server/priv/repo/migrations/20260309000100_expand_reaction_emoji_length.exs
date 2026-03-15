defmodule Vesper.Repo.Migrations.ExpandReactionEmojiLength do
  use Ecto.Migration

  def change do
    alter table(:reactions) do
      modify :emoji, :string, size: 128, null: false
    end
  end
end
