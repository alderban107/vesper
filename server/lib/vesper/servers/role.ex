defmodule Vesper.Servers.Role do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "roles" do
    field :name, :string
    field :color, :string
    field :permissions, :integer, default: 0
    field :position, :integer, default: 0

    belongs_to :server, Vesper.Servers.Server

    timestamps(type: :utc_datetime)
  end

  def changeset(role, attrs) do
    role
    |> cast(attrs, [:name, :color, :permissions, :position])
    |> validate_required([:name])
    |> validate_length(:name, min: 1, max: 100)
    |> validate_format(:color, ~r/^#[0-9a-fA-F]{6}$/, message: "must be a hex color")
  end
end
