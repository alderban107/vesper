defmodule Vesper.Repo.Migrations.AddRoomSequencesAndUserSyncEvents do
  use Ecto.Migration

  def up do
    alter table(:rooms) do
      add :current_seq, :bigint, null: false, default: 0
      add :last_message_seq, :bigint
      add :last_mutation_seq, :bigint
    end

    alter table(:room_events) do
      add :room_seq, :bigint
    end

    execute("""
    WITH sequenced AS (
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY inserted_at ASC, id ASC) AS seq
      FROM room_events
    )
    UPDATE room_events AS re
    SET room_seq = sequenced.seq
    FROM sequenced
    WHERE sequenced.id = re.id
    """)

    execute("""
    UPDATE rooms AS r
    SET
      current_seq = COALESCE(summary.max_seq, 0),
      last_message_seq = summary.last_message_seq,
      last_mutation_seq = summary.last_mutation_seq
    FROM (
      SELECT
        room_id,
        MAX(room_seq) AS max_seq,
        MAX(room_seq) FILTER (WHERE event_type = 'vesper.message') AS last_message_seq,
        MAX(room_seq) FILTER (WHERE event_type != 'vesper.message') AS last_mutation_seq
      FROM room_events
      GROUP BY room_id
    ) AS summary
    WHERE summary.room_id = r.id
    """)

    alter table(:room_events) do
      modify :room_seq, :bigint, null: false
    end

    create unique_index(:room_events, [:room_id, :room_seq])

    create table(:user_sync_events) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :event_type, :string, null: false
      add :scope_kind, :string
      add :scope_id, :binary_id
      add :payload, :map, null: false, default: %{}

      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:user_sync_events, [:user_id, :id])
    create index(:user_sync_events, [:user_id, :scope_kind, :scope_id, :id])
  end

  def down do
    drop table(:user_sync_events)
    drop index(:room_events, [:room_id, :room_seq])

    alter table(:room_events) do
      remove :room_seq
    end

    alter table(:rooms) do
      remove :last_mutation_seq
      remove :last_message_seq
      remove :current_seq
    end
  end
end
