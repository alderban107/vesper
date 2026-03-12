defmodule Vesper.Servers.ChannelRolePermission do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "channel_role_permissions" do
    field :allow, :integer, default: 0
    field :deny, :integer, default: 0

    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :role, Vesper.Servers.Role

    timestamps(type: :utc_datetime)
  end

  def changeset(permission, attrs) do
    permission
    |> cast(attrs, [:channel_id, :role_id, :allow, :deny])
    |> validate_required([:channel_id, :role_id, :allow, :deny])
    |> validate_number(:allow, greater_than_or_equal_to: 0)
    |> validate_number(:deny, greater_than_or_equal_to: 0)
    |> unique_constraint([:channel_id, :role_id])
  end
end
