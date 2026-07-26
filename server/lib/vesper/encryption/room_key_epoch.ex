defmodule Vesper.Encryption.RoomKeyEpoch do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_key_epochs" do
    field :topology_generation, :integer
    field :epoch, :integer
    field :state, Ecto.Enum, values: [:preparing, :staged, :active, :repair, :retired]
    field :reason, :string
    field :request_id, :string
    field :fencing_token, :integer
    field :coordinator_device_id, :string
    field :expected_cohort_count, :integer
    field :lease_expires_at, :utc_datetime
    field :activated_at, :utc_datetime
    field :retained_until, :utc_datetime
    field :repair_reason, :string

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :topology, Vesper.Encryption.RoomTopology
    belongs_to :coordinator_user, Vesper.Accounts.User

    has_many :envelopes, Vesper.Encryption.RoomKeyEnvelope, foreign_key: :room_key_epoch_id

    timestamps(type: :utc_datetime)
  end

  def changeset(epoch, attrs) do
    epoch
    |> cast(attrs, [
      :room_id,
      :topology_id,
      :topology_generation,
      :epoch,
      :state,
      :reason,
      :request_id,
      :fencing_token,
      :coordinator_user_id,
      :coordinator_device_id,
      :expected_cohort_count,
      :lease_expires_at,
      :activated_at,
      :retained_until,
      :repair_reason
    ])
    |> validate_required([
      :room_id,
      :topology_id,
      :topology_generation,
      :epoch,
      :state,
      :reason,
      :request_id,
      :fencing_token,
      :coordinator_device_id,
      :expected_cohort_count
    ])
    |> validate_number(:topology_generation, greater_than_or_equal_to: 1)
    |> validate_number(:epoch, greater_than_or_equal_to: 1)
    |> validate_number(:fencing_token, greater_than_or_equal_to: 1)
    |> validate_number(:expected_cohort_count, greater_than_or_equal_to: 1)
    |> unique_constraint([:room_id, :epoch])
    |> unique_constraint([:room_id, :request_id])
    |> unique_constraint(:room_id, name: :room_key_epochs_one_active_per_room)
    |> unique_constraint(:room_id, name: :room_key_epochs_one_open_per_room)
  end
end
