defmodule Vesper.Repo.Migrations.OptimizeReadPositionsAndSyncIndexes do
  use Ecto.Migration

  def up do
    alter table(:channel_read_positions) do
      add :last_read_seq, :bigint
    end

    alter table(:dm_read_positions) do
      add :last_read_seq, :bigint
    end

    execute("""
    UPDATE channel_read_positions AS positions
    SET last_read_seq = events.room_seq
    FROM room_events AS events
    JOIN messages AS messages ON messages.id = events.message_id
    WHERE positions.last_read_message_id = messages.id
      AND positions.channel_id = messages.channel_id
      AND events.event_type = 'vesper.message'
    """)

    execute("""
    UPDATE dm_read_positions AS positions
    SET last_read_seq = events.room_seq
    FROM room_events AS events
    JOIN messages AS messages ON messages.id = events.message_id
    WHERE positions.last_read_message_id = messages.id
      AND positions.conversation_id = messages.conversation_id
      AND events.event_type = 'vesper.message'
    """)

    create_if_not_exists index(:channel_read_positions, [:user_id, :channel_id, :last_read_seq])

    create_if_not_exists index(:dm_read_positions, [:user_id, :conversation_id, :last_read_seq])

    create_if_not_exists index(:room_events, [:room_id, :room_seq],
                           where: "event_type != 'vesper.message'",
                           name: :room_events_non_message_seq_idx
                         )
  end

  def down do
    drop_if_exists index(:room_events, [:room_id, :room_seq],
                   name: :room_events_non_message_seq_idx
                 )

    drop_if_exists index(:dm_read_positions, [:user_id, :conversation_id, :last_read_seq])
    drop_if_exists index(:channel_read_positions, [:user_id, :channel_id, :last_read_seq])

    alter table(:dm_read_positions) do
      remove :last_read_seq
    end

    alter table(:channel_read_positions) do
      remove :last_read_seq
    end
  end
end
