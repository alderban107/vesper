defmodule Vesper.Repo.Migrations.CreateServerEmojis do
  use Ecto.Migration

  def change do
    create table(:server_emojis, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :name, :string, null: false
      add :url, :string, null: false
      add :animated, :boolean, null: false, default: false
      add :storage_key, :string, null: false

      timestamps(type: :utc_datetime)
    end

    create index(:server_emojis, [:server_id])
    create unique_index(:server_emojis, [:server_id, :name])
  end
end
