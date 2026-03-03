defmodule Vesper.Repo.Migrations.CreateInvites do
  use Ecto.Migration

  def change do
    create table(:invites, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :creator_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :code, :string, null: false
      add :max_uses, :integer
      add :uses, :integer, default: 0, null: false
      add :expires_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create unique_index(:invites, [:code])
    create index(:invites, [:server_id])
  end
end
