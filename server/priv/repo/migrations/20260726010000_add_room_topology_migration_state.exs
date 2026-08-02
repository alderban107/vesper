defmodule Vesper.Repo.Migrations.AddRoomTopologyMigrationState do
  use Ecto.Migration

  def up do
    alter table(:messages) do
      add :encryption_scheme, :string, null: false, default: "mls"
      add :encryption_group_id, :string
    end

    alter table(:reactions) do
      add :encryption_scheme, :string, null: false, default: "mls"
      add :encryption_group_id, :string
    end

    alter table(:room_crypto_topologies) do
      add :request_id, :string

      add :previous_topology_id,
          references(:room_crypto_topologies, type: :binary_id, on_delete: :nilify_all)

      add :failure_reason, :string
    end

    create unique_index(:room_crypto_topologies, [:room_id, :request_id],
             where: "request_id IS NOT NULL",
             name: :room_crypto_topologies_room_request_unique
           )

    drop constraint(:room_crypto_topologies, :room_crypto_topologies_state_check)

    create constraint(:room_crypto_topologies, :room_crypto_topologies_state_check,
             check:
               "state IN ('preparing', 'cohorts_ready', 'room_key_ready', 'cutover_appended', 'active', 'retired', 'rolled_back')"
           )

    drop constraint(:room_key_epochs, :room_key_epochs_state_check)
    drop index(:room_key_epochs, [:room_id], name: :room_key_epochs_one_open_per_room)

    create constraint(:room_key_epochs, :room_key_epochs_state_check,
             check: "state IN ('preparing', 'staged', 'active', 'repair', 'retired')"
           )

    create unique_index(:room_key_epochs, [:room_id],
             where: "state IN ('preparing', 'staged', 'repair')",
             name: :room_key_epochs_one_open_per_room
           )
  end

  def down do
    execute("UPDATE room_key_epochs SET state = 'preparing' WHERE state = 'staged'")

    execute(
      "UPDATE room_crypto_topologies SET state = 'preparing' WHERE state IN ('cohorts_ready', 'room_key_ready', 'cutover_appended')"
    )

    drop index(:room_key_epochs, [:room_id], name: :room_key_epochs_one_open_per_room)
    drop constraint(:room_key_epochs, :room_key_epochs_state_check)

    create constraint(:room_key_epochs, :room_key_epochs_state_check,
             check: "state IN ('preparing', 'active', 'repair', 'retired')"
           )

    create unique_index(:room_key_epochs, [:room_id],
             where: "state IN ('preparing', 'repair')",
             name: :room_key_epochs_one_open_per_room
           )

    drop constraint(:room_crypto_topologies, :room_crypto_topologies_state_check)

    create constraint(:room_crypto_topologies, :room_crypto_topologies_state_check,
             check: "state IN ('preparing', 'active', 'retired', 'rolled_back')"
           )

    drop_if_exists index(:room_crypto_topologies, [:room_id, :request_id],
                     name: :room_crypto_topologies_room_request_unique
                   )

    alter table(:room_crypto_topologies) do
      remove :failure_reason
      remove :previous_topology_id
      remove :request_id
    end

    alter table(:reactions) do
      remove_if_exists :encryption_group_id
      remove_if_exists :encryption_scheme
    end

    alter table(:messages) do
      remove_if_exists :encryption_group_id
      remove_if_exists :encryption_scheme
    end
  end
end
