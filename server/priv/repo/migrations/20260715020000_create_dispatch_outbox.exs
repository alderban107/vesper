defmodule Vesper.Repo.Migrations.CreateDispatchOutbox do
  use Ecto.Migration

  def change do
    create table(:dispatch_outbox) do
      add :durable_key, :text, null: false
      add :scope_key, :text, null: false
      add :scope_topic, :text, null: false
      add :ordering_key, :bigint, null: false
      add :event, :text, null: false
      add :payload, :map, null: false, default: %{}
      add :status, :text, null: false, default: "pending"
      add :attempt_count, :integer, null: false, default: 0
      add :delivered_at, :utc_datetime
      add :dead_lettered_at, :utc_datetime
      add :last_error, :text

      timestamps(type: :utc_datetime)
    end

    create unique_index(:dispatch_outbox, [:durable_key])
    create index(:dispatch_outbox, [:scope_key, :status, :ordering_key])
    create index(:dispatch_outbox, [:status, :inserted_at])
  end
end
