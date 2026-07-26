defmodule Vesper.Repo.Migrations.CreateRoomKeyEpochs do
  use Ecto.Migration

  def change do
    create table(:room_key_epochs, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false

      add :topology_id,
          references(:room_crypto_topologies, type: :binary_id, on_delete: :delete_all),
          null: false

      add :topology_generation, :integer, null: false
      add :epoch, :bigint, null: false
      add :state, :string, null: false
      add :reason, :string, null: false
      add :request_id, :string, null: false
      add :fencing_token, :bigint, null: false
      add :coordinator_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :coordinator_device_id, :string, null: false
      add :expected_cohort_count, :integer, null: false
      add :lease_expires_at, :utc_datetime
      add :activated_at, :utc_datetime
      add :retained_until, :utc_datetime
      add :repair_reason, :string
      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_key_epochs, [:room_id, :epoch])
    create unique_index(:room_key_epochs, [:room_id, :request_id])

    create unique_index(:room_key_epochs, [:room_id],
             where: "state = 'active'",
             name: :room_key_epochs_one_active_per_room
           )

    create unique_index(:room_key_epochs, [:room_id],
             where: "state IN ('preparing', 'repair')",
             name: :room_key_epochs_one_open_per_room
           )

    create constraint(:room_key_epochs, :room_key_epochs_state_check,
             check: "state IN ('preparing', 'active', 'repair', 'retired')"
           )

    create constraint(:room_key_epochs, :room_key_epochs_positive_check,
             check:
               "topology_generation >= 1 AND epoch >= 1 AND fencing_token >= 1 AND expected_cohort_count >= 1"
           )

    create table(:room_key_envelopes, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :room_key_epoch_id,
          references(:room_key_epochs, type: :binary_id, on_delete: :delete_all),
          null: false

      add :cohort_id,
          references(:room_crypto_cohorts, type: :binary_id, on_delete: :delete_all),
          null: false

      add :group_id, :string, null: false
      add :wrapping_mls_epoch, :bigint, null: false
      add :ephemeral_public_key, :binary, null: false
      add :nonce, :binary, null: false
      add :ciphertext, :binary, null: false
      add :aad_digest, :binary, null: false
      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_key_envelopes, [:room_key_epoch_id, :cohort_id])
    create index(:room_key_envelopes, [:cohort_id, :wrapping_mls_epoch])

    create constraint(:room_key_envelopes, :room_key_envelopes_lengths_check,
             check:
               "octet_length(ephemeral_public_key) = 32 AND octet_length(nonce) = 12 AND " <>
                 "octet_length(ciphertext) = 48 AND octet_length(aad_digest) = 32"
           )
  end
end
