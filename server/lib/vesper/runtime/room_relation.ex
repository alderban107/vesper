defmodule Vesper.Runtime.RoomRelation do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_relations" do
    field :relation_type, :string
    field :content, :map, default: %{}

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :event, Vesper.Runtime.RoomEvent
    belongs_to :related_event, Vesper.Runtime.RoomEvent
    belongs_to :sender, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(relation, attrs) do
    relation
    |> cast(attrs, [
      :room_id,
      :event_id,
      :related_event_id,
      :sender_id,
      :relation_type,
      :content
    ])
    |> validate_required([:room_id, :event_id, :related_event_id, :relation_type])
  end
end
