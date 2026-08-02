defmodule Vesper.Encryption.RoomTopology do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_crypto_topologies" do
    field :mode, Ecto.Enum, values: [:single, :batched_single, :multi_cohort]
    field :generation, :integer
    field :target_cohort_size, :integer

    field :state,
          Ecto.Enum,
          values: [
            :preparing,
            :cohorts_ready,
            :room_key_ready,
            :cutover_appended,
            :active,
            :retired,
            :rolled_back
          ]

    field :request_id, :string
    field :failure_reason, :string
    field :cutover_room_seq, :integer
    field :activated_at, :utc_datetime
    field :retired_at, :utc_datetime

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :previous_topology, __MODULE__
    has_many :cohorts, Vesper.Encryption.RoomCohort, foreign_key: :topology_id
    timestamps(type: :utc_datetime)
  end

  def changeset(topology, attrs) do
    topology
    |> cast(attrs, [
      :room_id,
      :mode,
      :generation,
      :target_cohort_size,
      :state,
      :request_id,
      :previous_topology_id,
      :failure_reason,
      :cutover_room_seq,
      :activated_at,
      :retired_at
    ])
    |> validate_required([:room_id, :mode, :generation, :target_cohort_size, :state])
    |> validate_number(:generation, greater_than_or_equal_to: 1)
    |> validate_number(:target_cohort_size,
      greater_than_or_equal_to: 2,
      less_than_or_equal_to: 1000
    )
    |> unique_constraint([:room_id, :generation])
    |> unique_constraint([:room_id, :request_id],
      name: :room_crypto_topologies_room_request_unique
    )
    |> unique_constraint(:room_id, name: :room_crypto_topologies_one_active_per_room)
  end
end
