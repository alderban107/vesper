defmodule Vesper.Encryption.RoomHistoryAuthorization do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_history_authorizations" do
    field :authorization_generation, Ecto.UUID
    field :authorized_after_room_seq, :integer

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :user, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(authorization, attrs) do
    authorization
    |> cast(attrs, [
      :room_id,
      :user_id,
      :authorization_generation,
      :authorized_after_room_seq
    ])
    |> validate_required([
      :room_id,
      :user_id,
      :authorization_generation,
      :authorized_after_room_seq
    ])
    |> validate_number(:authorized_after_room_seq, greater_than_or_equal_to: 0)
    |> unique_constraint([:room_id, :user_id])
  end
end
