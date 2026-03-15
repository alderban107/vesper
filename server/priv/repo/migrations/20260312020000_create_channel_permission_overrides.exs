defmodule Vesper.Repo.Migrations.CreateChannelPermissionOverrides do
  use Ecto.Migration

  def change do
    create table(:channel_role_permissions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all),
        null: false

      add :role_id, references(:roles, type: :binary_id, on_delete: :delete_all), null: false
      add :allow, :bigint, null: false, default: 0
      add :deny, :bigint, null: false, default: 0

      timestamps(type: :utc_datetime)
    end

    create index(:channel_role_permissions, [:channel_id])
    create index(:channel_role_permissions, [:role_id])
    create unique_index(:channel_role_permissions, [:channel_id, :role_id])

    create table(:channel_user_permissions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all),
        null: false

      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :allow, :bigint, null: false, default: 0
      add :deny, :bigint, null: false, default: 0

      timestamps(type: :utc_datetime)
    end

    create index(:channel_user_permissions, [:channel_id])
    create index(:channel_user_permissions, [:user_id])
    create unique_index(:channel_user_permissions, [:channel_id, :user_id])
  end
end
