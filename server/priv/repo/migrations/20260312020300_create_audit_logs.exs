defmodule Vesper.Repo.Migrations.CreateAuditLogs do
  use Ecto.Migration

  def change do
    create table(:audit_logs, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :actor_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :target_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :action, :string, size: 64, null: false
      add :target_id, :string, size: 64
      add :metadata, :map, null: false, default: %{}

      timestamps(type: :utc_datetime)
    end

    create index(:audit_logs, [:server_id, :inserted_at])
    create index(:audit_logs, [:actor_id])
    create index(:audit_logs, [:target_user_id])
    create index(:audit_logs, [:action])
  end
end
