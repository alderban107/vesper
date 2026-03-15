defmodule Vesper.Repo.Migrations.CreateRoomsAndRoomEvents do
  use Ecto.Migration

  def up do
    create table(:rooms, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :kind, :string, null: false
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all)
      add :channel_id, references(:channels, type: :binary_id, on_delete: :delete_all)

      add :conversation_id,
          references(:dm_conversations, type: :binary_id, on_delete: :delete_all)

      timestamps(type: :utc_datetime)
    end

    create unique_index(:rooms, [:channel_id])
    create unique_index(:rooms, [:conversation_id])
    create index(:rooms, [:server_id])

    create constraint(:rooms, :rooms_single_binding_check,
             check:
               "((channel_id IS NOT NULL)::integer + (conversation_id IS NOT NULL)::integer) = 1"
           )

    create constraint(:rooms, :rooms_kind_matches_binding_check,
             check:
               "(kind = 'channel' AND channel_id IS NOT NULL AND conversation_id IS NULL) OR " <>
                 "(kind = 'dm' AND conversation_id IS NOT NULL AND channel_id IS NULL)"
           )

    create table(:room_events, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false
      add :sender_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :message_id, references(:messages, type: :binary_id, on_delete: :delete_all)
      add :event_type, :string, null: false
      add :content, :map, null: false, default: %{}
      add :ciphertext, :binary
      add :encryption_algorithm, :string
      add :mls_epoch, :bigint

      timestamps(type: :utc_datetime)
    end

    create index(:room_events, [:room_id, :inserted_at])
    create index(:room_events, [:room_id, :event_type])
    create unique_index(:room_events, [:message_id])

    create table(:room_state_events, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false
      add :sender_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :event_type, :string, null: false
      add :state_key, :string, null: false, default: ""
      add :content, :map, null: false, default: %{}
      add :ciphertext, :binary
      add :encryption_algorithm, :string

      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_state_events, [:room_id, :event_type, :state_key])
    create index(:room_state_events, [:room_id, :inserted_at])

    create table(:room_relations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false

      add :event_id, references(:room_events, type: :binary_id, on_delete: :delete_all),
        null: false

      add :related_event_id, references(:room_events, type: :binary_id, on_delete: :delete_all),
        null: false

      add :sender_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :relation_type, :string, null: false
      add :content, :map, null: false, default: %{}

      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_relations, [:event_id, :related_event_id, :relation_type])
    create index(:room_relations, [:room_id, :relation_type])
    create index(:room_relations, [:related_event_id])

    execute("""
    INSERT INTO rooms (id, kind, server_id, channel_id, inserted_at, updated_at)
    SELECT gen_random_uuid(), 'channel', c.server_id, c.id, NOW(), NOW()
    FROM channels c
    LEFT JOIN rooms r ON r.channel_id = c.id
    WHERE r.id IS NULL
    """)

    execute("""
    INSERT INTO rooms (id, kind, server_id, conversation_id, inserted_at, updated_at)
    SELECT gen_random_uuid(), 'dm', NULL, c.id, NOW(), NOW()
    FROM dm_conversations c
    LEFT JOIN rooms r ON r.conversation_id = c.id
    WHERE r.id IS NULL
    """)

    execute("""
    INSERT INTO room_events (
      id,
      room_id,
      sender_id,
      message_id,
      event_type,
      content,
      ciphertext,
      encryption_algorithm,
      mls_epoch,
      inserted_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      r.id,
      m.sender_id,
      m.id,
      'vesper.message',
      jsonb_strip_nulls(
        jsonb_build_object(
          'parent_message_id', m.parent_message_id,
          'edited_at', m.edited_at,
          'expires_at', m.expires_at
        )
      ),
      m.ciphertext,
      CASE WHEN m.ciphertext IS NULL THEN NULL ELSE 'mls' END,
      m.mls_epoch,
      m.inserted_at,
      NOW()
    FROM messages m
    JOIN rooms r
      ON (m.channel_id IS NOT NULL AND r.channel_id = m.channel_id)
      OR (m.conversation_id IS NOT NULL AND r.conversation_id = m.conversation_id)
    LEFT JOIN room_events re ON re.message_id = m.id
    WHERE re.id IS NULL
    """)

    execute("""
    INSERT INTO room_relations (
      id,
      room_id,
      event_id,
      related_event_id,
      sender_id,
      relation_type,
      content,
      inserted_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      child.room_id,
      child.id,
      parent.id,
      m.sender_id,
      'vesper.thread',
      '{}'::jsonb,
      NOW(),
      NOW()
    FROM messages m
    JOIN room_events child ON child.message_id = m.id
    JOIN room_events parent ON parent.message_id = m.parent_message_id
    LEFT JOIN room_relations rr
      ON rr.event_id = child.id
      AND rr.related_event_id = parent.id
      AND rr.relation_type = 'vesper.thread'
    WHERE m.parent_message_id IS NOT NULL
      AND rr.id IS NULL
    """)
  end

  def down do
    drop table(:room_relations)
    drop table(:room_state_events)
    drop table(:room_events)
    drop table(:rooms)
  end
end
