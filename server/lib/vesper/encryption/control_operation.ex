defmodule Vesper.Encryption.ControlOperation do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_control_operations" do
    field :actor_client_id, :string
    field :scope_kind, :string
    field :scope_id, :string
    field :operation, :string
    field :idempotency_key, :string
    field :payload_hash, :binary
    field :state, :string, default: "pending"
    field :result, :map

    belongs_to :actor, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(operation, attrs) do
    operation
    |> cast(attrs, [
      :actor_id,
      :actor_client_id,
      :scope_kind,
      :scope_id,
      :operation,
      :idempotency_key,
      :payload_hash,
      :state,
      :result
    ])
    |> validate_required([
      :actor_id,
      :actor_client_id,
      :scope_kind,
      :scope_id,
      :operation,
      :idempotency_key,
      :payload_hash,
      :state
    ])
    |> validate_inclusion(:state, ["pending", "accepted"])
    |> unique_constraint(
      [
        :actor_id,
        :actor_client_id,
        :scope_kind,
        :scope_id,
        :operation,
        :idempotency_key
      ],
      name: :mls_control_operations_idempotency_index
    )
  end
end
