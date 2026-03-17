defmodule Vesper.Repo.Migrations.CreateMlsEvents do
  use Ecto.Migration

  def change do
    create table(:mls_events) do
      add(:group_id, :string, null: false)
      add(:event_type, :string, null: false)
      add(:payload, :map, null: false, default: %{})
      add(:sender_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false)
      add(:sender_device_id, :string)
      add(:channel_id, references(:channels, type: :binary_id, on_delete: :delete_all))

      add(
        :conversation_id,
        references(:dm_conversations, type: :binary_id, on_delete: :delete_all)
      )

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create(index(:mls_events, [:group_id, :id]))
    create(index(:mls_events, [:channel_id, :id]))
    create(index(:mls_events, [:conversation_id, :id]))
  end
end
