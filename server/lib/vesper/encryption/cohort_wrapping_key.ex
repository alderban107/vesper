defmodule Vesper.Encryption.CohortWrappingKey do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "cohort_wrapping_keys" do
    field :group_id, :string
    field :topology_generation, :integer
    field :mls_epoch, :integer
    field :public_key, :binary
    field :signature, :binary
    field :signer_identity, :string
    field :signer_public_key, :binary
    field :group_info_digest, :binary
    field :publisher_device_id, :string

    belongs_to :room, Vesper.Runtime.Room
    belongs_to :cohort, Vesper.Encryption.RoomCohort
    belongs_to :publisher, Vesper.Accounts.User
    timestamps(type: :utc_datetime)
  end

  def changeset(key, attrs) do
    key
    |> cast(attrs, [
      :group_id,
      :room_id,
      :cohort_id,
      :topology_generation,
      :mls_epoch,
      :public_key,
      :signature,
      :signer_identity,
      :signer_public_key,
      :group_info_digest,
      :publisher_id,
      :publisher_device_id
    ])
    |> validate_required([
      :group_id,
      :room_id,
      :cohort_id,
      :topology_generation,
      :mls_epoch,
      :public_key,
      :signature,
      :signer_identity,
      :signer_public_key,
      :group_info_digest,
      :publisher_device_id
    ])
    |> validate_number(:topology_generation, greater_than_or_equal_to: 1)
    |> validate_number(:mls_epoch, greater_than_or_equal_to: 0)
    |> validate_binary_size(:public_key, 32)
    |> validate_binary_size(:signature, 64)
    |> validate_binary_size(:signer_public_key, 32)
    |> validate_binary_size(:group_info_digest, 32)
    |> unique_constraint(:group_id)
  end

  defp validate_binary_size(changeset, field, expected_size) do
    validate_change(changeset, field, fn ^field, value ->
      if is_binary(value) and byte_size(value) == expected_size,
        do: [],
        else: [{field, "must be #{expected_size} bytes"}]
    end)
  end
end
