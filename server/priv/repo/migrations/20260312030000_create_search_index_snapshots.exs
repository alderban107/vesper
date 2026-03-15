defmodule Vesper.Repo.Migrations.CreateSearchIndexSnapshots do
  use Ecto.Migration

  def change do
    create table(:search_index_snapshots, primary_key: false) do
      add(:id, :binary_id, primary_key: true)
      add(:user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false)
      add(:device_id, :string, null: false)
      add(:version, :integer, null: false, default: 1)
      add(:ciphertext, :binary, null: false)
      add(:nonce, :binary, null: false)

      timestamps(type: :utc_datetime)
    end

    create(unique_index(:search_index_snapshots, [:user_id]))
    create(index(:search_index_snapshots, [:updated_at]))
  end
end
