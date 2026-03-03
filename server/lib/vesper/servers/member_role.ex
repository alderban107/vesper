defmodule Vesper.Servers.MemberRole do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "member_roles" do
    belongs_to :membership, Vesper.Servers.Membership
    belongs_to :role, Vesper.Servers.Role

    timestamps(type: :utc_datetime)
  end

  def changeset(member_role, attrs) do
    member_role
    |> cast(attrs, [:membership_id, :role_id])
    |> validate_required([:membership_id, :role_id])
    |> unique_constraint([:membership_id, :role_id])
  end
end
