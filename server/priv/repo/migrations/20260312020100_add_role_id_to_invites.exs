defmodule Vesper.Repo.Migrations.AddRoleIdToInvites do
  use Ecto.Migration

  def change do
    alter table(:invites) do
      add :role_id, references(:roles, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:invites, [:role_id])
  end
end
