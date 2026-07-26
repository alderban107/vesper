defmodule Vesper.Repo.Migrations.AddRoomActivityOrder do
  use Ecto.Migration

  def up do
    alter table(:rooms) do
      add :activity_at, :utc_datetime_usec
    end

    execute("""
    UPDATE rooms AS room
    SET activity_at = COALESCE(room.last_message_at, conversation.inserted_at, room.inserted_at)
    FROM dm_conversations AS conversation
    WHERE room.kind = 'dm'
      AND room.conversation_id = conversation.id
    """)

    execute("""
    UPDATE rooms
    SET activity_at = COALESCE(last_message_at, inserted_at)
    WHERE activity_at IS NULL
    """)

    alter table(:rooms) do
      modify :activity_at, :utc_datetime_usec, null: false
    end

    create index(:rooms, [:kind, :activity_at, :conversation_id],
             name: :rooms_kind_activity_conversation_idx
           )
  end

  def down do
    drop_if_exists index(:rooms, [:kind, :activity_at, :conversation_id],
                     name: :rooms_kind_activity_conversation_idx
                   )

    alter table(:rooms) do
      remove :activity_at
    end
  end
end
