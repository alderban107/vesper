defmodule Vesper.DispatchOutbox do
  use Ecto.Schema
  import Ecto.Changeset

  @statuses ~w(pending delivered failed dead)

  schema "dispatch_outbox" do
    field :durable_key, :string
    field :scope_key, :string
    field :scope_topic, :string
    field :ordering_key, :integer
    field :event, :string
    field :payload, :map, default: %{}
    field :status, :string, default: "pending"
    field :attempt_count, :integer, default: 0
    field :delivered_at, :utc_datetime
    field :dead_lettered_at, :utc_datetime
    field :last_error, :string

    timestamps(type: :utc_datetime)
  end

  def changeset(dispatch, attrs) do
    dispatch
    |> cast(attrs, [
      :durable_key,
      :scope_key,
      :scope_topic,
      :ordering_key,
      :event,
      :payload,
      :status,
      :attempt_count,
      :delivered_at,
      :dead_lettered_at,
      :last_error
    ])
    |> validate_required([:durable_key, :scope_key, :scope_topic, :ordering_key, :event, :status])
    |> validate_inclusion(:status, @statuses)
    |> unique_constraint(:durable_key)
  end
end
