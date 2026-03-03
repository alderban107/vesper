defmodule Vesper.Repo.Migrations.CreateMemberships do
  use Ecto.Migration

  def change do
    create table(:memberships, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :role, :string, size: 16, null: false, default: "member"
      add :nickname, :string, size: 64

      add :joined_at, :utc_datetime, null: false, default: fragment("now()")
    end

    create unique_index(:memberships, [:user_id, :server_id])
    create index(:memberships, [:server_id])
  end
end
