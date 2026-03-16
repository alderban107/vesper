defmodule Vesper.Repo.Migrations.ScopeMlsMetadataToDevices do
  use Ecto.Migration

  def change do
    alter table(:key_packages) do
      add :client_id, :string
    end

    execute("UPDATE key_packages SET client_id = 'legacy' WHERE client_id IS NULL")

    alter table(:key_packages) do
      modify :client_id, :string, null: false
    end

    drop_if_exists index(:key_packages, [:user_id, :consumed])
    create index(:key_packages, [:user_id, :client_id, :consumed])

    alter table(:mls_pending_welcomes) do
      add :recipient_client_id, :string
      add :recipient_key_package_ref, :text
    end

    alter table(:mls_pending_resync_requests) do
      add :requester_client_id, :string
    end

    execute(
      "UPDATE mls_pending_resync_requests SET requester_client_id = 'legacy' WHERE requester_client_id IS NULL"
    )

    alter table(:mls_pending_resync_requests) do
      modify :requester_client_id, :string, null: false
    end

    drop_if_exists unique_index(:mls_pending_resync_requests, [:group_id, :requester_id])

    create unique_index(:mls_pending_resync_requests, [
             :group_id,
             :requester_id,
             :requester_client_id
           ])
  end
end
