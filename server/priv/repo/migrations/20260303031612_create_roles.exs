defmodule Vesper.Repo.Migrations.CreateRoles do
  use Ecto.Migration

  def change do
    create table(:roles, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :name, :string, size: 100, null: false
      # hex color like #ff0000
      add :color, :string, size: 7
      add :permissions, :bigint, null: false, default: 0
      add :position, :integer, null: false, default: 0

      timestamps(type: :utc_datetime)
    end

    create index(:roles, [:server_id])

    create table(:member_roles, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :membership_id, references(:memberships, type: :binary_id, on_delete: :delete_all),
        null: false

      add :role_id, references(:roles, type: :binary_id, on_delete: :delete_all), null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:member_roles, [:membership_id, :role_id])
  end
end
