defmodule Vesper.Repo.Migrations.CreateRoomCryptoTopologies do
  use Ecto.Migration

  def change do
    create table(:room_crypto_topologies, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false
      add :mode, :string, null: false
      add :generation, :integer, null: false
      add :target_cohort_size, :integer, null: false
      add :state, :string, null: false
      add :cutover_room_seq, :bigint
      add :activated_at, :utc_datetime
      add :retired_at, :utc_datetime
      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_crypto_topologies, [:room_id, :generation])

    create unique_index(:room_crypto_topologies, [:room_id],
             where: "state = 'active'",
             name: :room_crypto_topologies_one_active_per_room
           )

    create constraint(:room_crypto_topologies, :room_crypto_topologies_mode_check,
             check: "mode IN ('single', 'batched_single', 'multi_cohort')"
           )

    create constraint(:room_crypto_topologies, :room_crypto_topologies_state_check,
             check: "state IN ('preparing', 'active', 'retired', 'rolled_back')"
           )

    create constraint(:room_crypto_topologies, :room_crypto_topologies_generation_check,
             check: "generation >= 1"
           )

    create constraint(:room_crypto_topologies, :room_crypto_topologies_target_size_check,
             check: "target_cohort_size >= 2 AND target_cohort_size <= 1000"
           )

    create table(:room_crypto_cohorts, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :topology_id,
          references(:room_crypto_topologies, type: :binary_id, on_delete: :delete_all),
          null: false

      add :ordinal, :integer, null: false
      add :group_id, :string, null: false
      add :state, :string, null: false, default: "active"
      add :retired_at, :utc_datetime
      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_crypto_cohorts, [:topology_id, :ordinal])
    create unique_index(:room_crypto_cohorts, [:group_id])

    create constraint(:room_crypto_cohorts, :room_crypto_cohorts_ordinal_check,
             check: "ordinal >= 0"
           )

    create constraint(:room_crypto_cohorts, :room_crypto_cohorts_state_check,
             check: "state IN ('active', 'retired')"
           )

    create table(:room_crypto_cohort_memberships, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :topology_id,
          references(:room_crypto_topologies, type: :binary_id, on_delete: :delete_all),
          null: false

      add :cohort_id,
          references(:room_crypto_cohorts, type: :binary_id, on_delete: :delete_all),
          null: false

      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_crypto_cohort_memberships, [:topology_id, :user_id])
    create unique_index(:room_crypto_cohort_memberships, [:cohort_id, :user_id])
    create index(:room_crypto_cohort_memberships, [:cohort_id])
  end
end
