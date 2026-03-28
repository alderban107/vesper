defmodule Vesper.Repo.Migrations.AddIsReplyToMessages do
  use Ecto.Migration

  def change do
    alter table(:messages) do
      add :is_reply, :boolean, null: false, default: false
    end
  end
end
