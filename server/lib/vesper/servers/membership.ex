defmodule Vesper.Servers.Membership do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "memberships" do
    field :role, :string, default: "member"
    field :nickname, :string
    field :joined_at, :utc_datetime

    belongs_to :user, Vesper.Accounts.User
    belongs_to :server, Vesper.Servers.Server
  end

  def changeset(membership, attrs) do
    membership
    |> cast(attrs, [:role, :nickname])
    |> validate_required([:role])
    |> validate_inclusion(:role, ~w(owner admin moderator member))
    |> unique_constraint([:user_id, :server_id])
  end
end
