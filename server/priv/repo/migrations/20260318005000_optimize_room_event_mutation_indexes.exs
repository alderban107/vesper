defmodule Vesper.Repo.Migrations.OptimizeRoomEventMutationIndexes do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def up do
    create_if_not_exists index(:room_events, [:room_id, :room_seq],
                           concurrently: true,
                           where: "event_type != 'vesper.message'",
                           name: :room_events_mutation_room_seq_idx
                         )

    create_if_not_exists index(:room_events, [:room_id, :inserted_at],
                           concurrently: true,
                           where: "event_type != 'vesper.message'",
                           name: :room_events_mutation_inserted_at_idx
                         )
  end

  def down do
    drop_if_exists index(:room_events, [:room_id, :room_seq],
                     name: :room_events_mutation_room_seq_idx
                   )

    drop_if_exists index(:room_events, [:room_id, :inserted_at],
                     name: :room_events_mutation_inserted_at_idx
                   )
  end
end
