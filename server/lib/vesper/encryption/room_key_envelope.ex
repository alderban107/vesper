defmodule Vesper.Encryption.RoomKeyEnvelope do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_key_envelopes" do
    field :group_id, :string
    field :wrapping_mls_epoch, :integer
    field :ephemeral_public_key, :binary
    field :nonce, :binary
    field :ciphertext, :binary
    field :aad_digest, :binary

    belongs_to :room_key_epoch, Vesper.Encryption.RoomKeyEpoch
    belongs_to :cohort, Vesper.Encryption.RoomCohort
    timestamps(type: :utc_datetime)
  end

  def changeset(envelope, attrs) do
    envelope
    |> cast(attrs, [
      :room_key_epoch_id,
      :cohort_id,
      :group_id,
      :wrapping_mls_epoch,
      :ephemeral_public_key,
      :nonce,
      :ciphertext,
      :aad_digest
    ])
    |> validate_required([
      :room_key_epoch_id,
      :cohort_id,
      :group_id,
      :wrapping_mls_epoch,
      :ephemeral_public_key,
      :nonce,
      :ciphertext,
      :aad_digest
    ])
    |> validate_number(:wrapping_mls_epoch, greater_than_or_equal_to: 0)
    |> validate_binary_size(:ephemeral_public_key, 32)
    |> validate_binary_size(:nonce, 12)
    |> validate_binary_size(:ciphertext, 48)
    |> validate_binary_size(:aad_digest, 32)
    |> unique_constraint([:room_key_epoch_id, :cohort_id])
  end

  defp validate_binary_size(changeset, field, expected_size) do
    validate_change(changeset, field, fn ^field, value ->
      if is_binary(value) and byte_size(value) == expected_size,
        do: [],
        else: [{field, "must be #{expected_size} bytes"}]
    end)
  end
end
