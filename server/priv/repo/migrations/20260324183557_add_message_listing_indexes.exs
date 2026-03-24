defmodule Vesper.Repo.Migrations.AddMessageListingIndexes do
  use Ecto.Migration

  def change do
    # Fast last-message lookup per conversation (used by conversations_with_last_message)
    create_if_not_exists index(:messages, [:conversation_id, :inserted_at],
      name: :messages_conversation_inserted_at_idx,
      where: "conversation_id IS NOT NULL"
    )

    # Fast last-message lookup per channel (used by channel activity snapshots)
    create_if_not_exists index(:messages, [:channel_id, :inserted_at],
      name: :messages_channel_inserted_at_idx,
      where: "channel_id IS NOT NULL"
    )

    # Fast room event lookup by room + seq (used by scope sync after_seq)
    create_if_not_exists index(:room_events, [:room_id, :room_seq])
  end
end
