defmodule Vesper.Encryption.RoomKeyEpochAuthorization do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_key_epoch_authorizations" do
    field :authorization_generation, Ecto.UUID

    belongs_to :room_key_epoch, Vesper.Encryption.RoomKeyEpoch
    belongs_to :user, Vesper.Accounts.User
    belongs_to :cohort, Vesper.Encryption.RoomCohort

    timestamps(type: :utc_datetime)
  end

  def changeset(authorization, attrs) do
    authorization
    |> cast(attrs, [
      :room_key_epoch_id,
      :user_id,
      :cohort_id,
      :authorization_generation
    ])
    |> validate_required([
      :room_key_epoch_id,
      :user_id,
      :cohort_id,
      :authorization_generation
    ])
    |> unique_constraint([:room_key_epoch_id, :user_id])
  end
end
