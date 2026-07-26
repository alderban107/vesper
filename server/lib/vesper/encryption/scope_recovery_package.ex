defmodule Vesper.Encryption.ScopeRecoveryPackage do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "scope_recovery_packages" do
    field :scope_id, :string
    field :ciphertext, :string
    field :nonce, :binary
    field :membership_generation, :integer
    field :last_event_seq, :integer, default: 0
    field :schema_version, :integer, default: 1
    field :byte_size, :integer
    field :expires_at, :utc_datetime

    belongs_to :owner, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(package, attrs) do
    package
    |> cast(attrs, [
      :scope_id,
      :owner_id,
      :ciphertext,
      :nonce,
      :membership_generation,
      :last_event_seq,
      :schema_version,
      :byte_size,
      :expires_at
    ])
    |> validate_required([
      :scope_id,
      :owner_id,
      :ciphertext,
      :nonce,
      :membership_generation,
      :last_event_seq,
      :schema_version,
      :byte_size,
      :expires_at
    ])
    |> validate_number(:membership_generation, greater_than_or_equal_to: 0)
    |> validate_number(:last_event_seq, greater_than_or_equal_to: 0)
    |> validate_number(:byte_size, greater_than: 0, less_than_or_equal_to: 262_144)
    |> unique_constraint([:scope_id, :owner_id])
  end
end
