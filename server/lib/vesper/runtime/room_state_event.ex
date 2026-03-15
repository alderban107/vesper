defmodule Vesper.Runtime.RoomStateEvent do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_state_events" do
    field :event_type, :string
    field :state_key, :string, default: ""
    field :content, :map, default: %{}
    field :ciphertext, :binary
    field :encryption_algorithm, :string

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :sender, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(event, attrs) do
    event
    |> cast(attrs, [
      :room_id,
      :sender_id,
      :event_type,
      :state_key,
      :content,
      :ciphertext,
      :encryption_algorithm
    ])
    |> validate_required([:room_id, :event_type, :state_key])
  end
end
