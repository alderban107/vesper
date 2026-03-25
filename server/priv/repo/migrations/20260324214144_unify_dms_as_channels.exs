defmodule Vesper.Repo.Migrations.UnifyDmsAsChannels do
  use Ecto.Migration

  def change do
    # 1. Channels: allow server_id and name to be null (DM channels have no parent server or name)
    alter table(:channels) do
      modify :server_id, :binary_id, null: true
      modify :name, :string, null: true
    end

    # 2. Memberships: support channel-direct membership (DMs) + archiving
    alter table(:memberships) do
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)
      add :archived_at, :utc_datetime
      modify :server_id, :binary_id, null: true
    end

    # Channel-direct membership uniqueness (for DM channels)
    create unique_index(:memberships, [:user_id, :channel_id],
             where: "channel_id IS NOT NULL",
             name: :memberships_user_channel_idx
           )

    # 3. DM conversations: link to backing channel
    alter table(:dm_conversations) do
      add :channel_id, references(:channels, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:dm_conversations, [:channel_id])

    # 4. Partial index for DM channel lookups
    create index(:channels, [:type],
             where: "type IN ('dm', 'group_dm')",
             name: :channels_dm_type_idx
           )
  end
end
