defmodule Vesper.Encryption.RoomCohort do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_crypto_cohorts" do
    field :ordinal, :integer
    field :group_id, :string
    field :state, Ecto.Enum, values: [:active, :retired], default: :active
    field :retired_at, :utc_datetime

    belongs_to :topology, Vesper.Encryption.RoomTopology
    has_many :memberships, Vesper.Encryption.RoomCohortMembership, foreign_key: :cohort_id
    timestamps(type: :utc_datetime)
  end

  def changeset(cohort, attrs) do
    cohort
    |> cast(attrs, [:topology_id, :ordinal, :group_id, :state, :retired_at])
    |> validate_required([:topology_id, :ordinal, :group_id, :state])
    |> validate_number(:ordinal, greater_than_or_equal_to: 0)
    |> unique_constraint([:topology_id, :ordinal])
    |> unique_constraint(:group_id)
  end
end
