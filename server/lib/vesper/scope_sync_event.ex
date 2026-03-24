defmodule Vesper.ScopeSyncEvent do
  use Ecto.Schema

  @primary_key {:id, :id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "scope_sync_events" do
    field :event_type, :string
    field :scope_kind, :string
    field :scope_id, :binary_id
    field :payload, :map, default: %{}

    timestamps(type: :utc_datetime, updated_at: false)
  end
end
