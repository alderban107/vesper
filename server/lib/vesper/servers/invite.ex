defmodule Vesper.Servers.Invite do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "invites" do
    field :code, :string
    field :max_uses, :integer
    field :uses, :integer, default: 0
    field :expires_at, :utc_datetime

    belongs_to :server, Vesper.Servers.Server
    belongs_to :creator, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(invite, attrs) do
    invite
    |> cast(attrs, [:code, :max_uses, :expires_at, :server_id, :creator_id])
    |> validate_required([:code, :server_id, :creator_id])
    |> unique_constraint(:code)
  end

  def generate_code do
    :crypto.strong_rand_bytes(9) |> Base.url_encode64(padding: false)
  end
end
