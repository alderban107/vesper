defmodule Vesper.Repo.Migrations.CreateServers do
  use Ecto.Migration

  def change do
    create table(:servers, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :name, :string, size: 100, null: false
      add :icon_url, :text
      add :owner_id, references(:users, type: :binary_id), null: false
      add :invite_code, :string, size: 16

      timestamps(type: :utc_datetime)
    end

    create unique_index(:servers, [:invite_code])
    create index(:servers, [:owner_id])
  end
end
