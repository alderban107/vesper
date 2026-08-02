defmodule Vesper.Repo.Migrations.CreateCohortWrappingKeys do
  use Ecto.Migration

  def change do
    create table(:cohort_wrapping_keys, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :group_id, :string, null: false
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false

      add :cohort_id, references(:room_crypto_cohorts, type: :binary_id, on_delete: :delete_all),
        null: false

      add :topology_generation, :integer, null: false
      add :mls_epoch, :integer, null: false
      add :public_key, :binary, null: false
      add :signature, :binary, null: false
      add :signer_identity, :string, null: false
      add :signer_public_key, :binary, null: false
      add :group_info_digest, :binary, null: false
      add :publisher_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :publisher_device_id, :string, null: false
      timestamps(type: :utc_datetime)
    end

    create unique_index(:cohort_wrapping_keys, [:group_id])
    create index(:cohort_wrapping_keys, [:cohort_id, :mls_epoch])

    create constraint(:cohort_wrapping_keys, :cohort_wrapping_keys_lengths_check,
             check:
               "octet_length(public_key) = 32 AND octet_length(signature) = 64 AND " <>
                 "octet_length(signer_public_key) = 32 AND octet_length(group_info_digest) = 32"
           )
  end
end
