defmodule Vesper.Repo.Migrations.CreateServerBans do
  use Ecto.Migration

  def change do
    create table(:server_bans, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :banned_by_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :reason, :text

      timestamps(type: :utc_datetime)
    end

    create unique_index(:server_bans, [:server_id, :user_id])
    create index(:server_bans, [:server_id])
    create index(:server_bans, [:user_id])
  end
end
