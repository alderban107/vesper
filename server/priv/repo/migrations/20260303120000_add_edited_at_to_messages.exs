defmodule Vesper.Repo.Migrations.AddEditedAtToMessages do
  use Ecto.Migration

  def change do
    alter table(:messages) do
      add :edited_at, :utc_datetime
    end
  end
end
