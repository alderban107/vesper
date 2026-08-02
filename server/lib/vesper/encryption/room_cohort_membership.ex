defmodule Vesper.Encryption.RoomCohortMembership do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_crypto_cohort_memberships" do
    belongs_to :topology, Vesper.Encryption.RoomTopology
    belongs_to :cohort, Vesper.Encryption.RoomCohort
    belongs_to :user, Vesper.Accounts.User
    timestamps(type: :utc_datetime)
  end

  def changeset(membership, attrs) do
    membership
    |> cast(attrs, [:topology_id, :cohort_id, :user_id])
    |> validate_required([:topology_id, :cohort_id, :user_id])
    |> unique_constraint([:topology_id, :user_id])
    |> unique_constraint([:cohort_id, :user_id])
  end
end
