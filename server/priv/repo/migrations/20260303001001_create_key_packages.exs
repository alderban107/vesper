defmodule Vesper.Repo.Migrations.CreateKeyPackages do
  use Ecto.Migration

  def change do
    create table(:key_packages, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :key_package_data, :binary, null: false
      add :consumed, :boolean, default: false, null: false

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:key_packages, [:user_id, :consumed])
  end
end
