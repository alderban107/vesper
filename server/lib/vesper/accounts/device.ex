defmodule Vesper.Accounts.Device do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @trust_states ~w(trusted pending revoked)

  schema "devices" do
    field :client_id, :string
    field :name, :string
    field :platform, :string
    field :trust_state, :string, default: "pending"
    field :approval_method, :string
    field :trusted_at, :utc_datetime
    field :revoked_at, :utc_datetime
    field :last_seen_at, :utc_datetime

    belongs_to :user, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def trust_states, do: @trust_states

  def changeset(device, attrs) do
    device
    |> cast(attrs, [
      :user_id,
      :client_id,
      :name,
      :platform,
      :trust_state,
      :approval_method,
      :trusted_at,
      :revoked_at,
      :last_seen_at
    ])
    |> validate_required([:user_id, :client_id, :name, :trust_state])
    |> validate_inclusion(:trust_state, @trust_states)
    |> validate_length(:name, min: 1, max: 128)
    |> unique_constraint([:user_id, :client_id])
  end
end
