defmodule Vesper.Repo.Migrations.AddRoomSyncSummaryFields do
  use Ecto.Migration

  def up do
    alter table(:rooms) do
      add :last_message_id, references(:messages, type: :binary_id, on_delete: :nilify_all)
      add :last_message_at, :utc_datetime
      add :last_mutation_at, :utc_datetime
    end

    create index(:rooms, [:last_message_id])
    create index(:rooms, [:last_message_at])
    create index(:rooms, [:last_mutation_at])

    execute("""
    UPDATE rooms AS r
    SET
      last_message_id = latest.message_id,
      last_message_at = latest.inserted_at
    FROM (
      SELECT DISTINCT ON (room_id)
        room_id,
        message_id,
        inserted_at
      FROM room_events
      WHERE event_type = 'vesper.message'
        AND message_id IS NOT NULL
      ORDER BY room_id, inserted_at DESC, message_id DESC
    ) AS latest
    WHERE latest.room_id = r.id
    """)

    execute("""
    UPDATE rooms AS r
    SET last_mutation_at = latest.inserted_at
    FROM (
      SELECT
        room_id,
        MAX(inserted_at) AS inserted_at
      FROM room_events
      WHERE event_type != 'vesper.message'
      GROUP BY room_id
    ) AS latest
    WHERE latest.room_id = r.id
    """)
  end

  def down do
    drop index(:rooms, [:last_mutation_at])
    drop index(:rooms, [:last_message_at])
    drop index(:rooms, [:last_message_id])

    alter table(:rooms) do
      remove :last_mutation_at
      remove :last_message_at
      remove :last_message_id
    end
  end
end
