defmodule Vesper.Repo.Migrations.CreateMlsGroupInfo do
  use Ecto.Migration

  def change do
    create table(:mls_group_info, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :group_id, :string, null: false
      add :group_info_data, :binary, null: false
      add :ratchet_tree_data, :binary
      add :epoch, :bigint, null: false, default: 0
      add :publisher_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :publisher_client_id, :string
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)
      add :conversation_id, references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      timestamps(type: :utc_datetime, updated_at: :updated_at)
    end

    # Only one GroupInfo per scope — upsert on group_id
    create unique_index(:mls_group_info, [:group_id])

    # Lookup by channel or conversation for batch fetches
    create index(:mls_group_info, [:channel_id])
    create index(:mls_group_info, [:conversation_id])
  end
end
