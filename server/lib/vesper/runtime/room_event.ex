defmodule Vesper.Runtime.RoomEvent do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_events" do
    field :event_type, :string
    field :content, :map, default: %{}
    field :ciphertext, :binary
    field :encryption_algorithm, :string
    field :mls_epoch, :integer

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :message, Vesper.Chat.Message

    timestamps(type: :utc_datetime)
  end

  def changeset(event, attrs) do
    event
    |> cast(attrs, [
      :room_id,
      :sender_id,
      :message_id,
      :event_type,
      :content,
      :ciphertext,
      :encryption_algorithm,
      :mls_epoch
    ])
    |> validate_required([:room_id, :event_type])
  end
end
