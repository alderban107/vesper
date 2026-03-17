defmodule Vesper.UserSyncEvent do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "user_sync_events" do
    field :event_type, :string
    field :scope_kind, :string
    field :scope_id, :binary_id
    field :payload, :map, default: %{}

    belongs_to :user, Vesper.Accounts.User

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(event, attrs) do
    event
    |> cast(attrs, [:user_id, :event_type, :scope_kind, :scope_id, :payload])
    |> validate_required([:user_id, :event_type])
  end
end
