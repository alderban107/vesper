defmodule Vesper.Repo.Migrations.AddMlsCommitIdempotencyKeyToMlsEvents do
  use Ecto.Migration

  def change do
    alter table(:mls_events) do
      add(:idempotency_key, :string)
    end

    create(
      unique_index(
        :mls_events,
        [:group_id, :event_type, :sender_id, :sender_device_id, :idempotency_key],
        where: "event_type = 'mls_commit' AND idempotency_key IS NOT NULL",
        name: :mls_events_commit_idempotency_index
      )
    )
  end
end
