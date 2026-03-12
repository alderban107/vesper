defmodule Vesper.Servers.ServerBan do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "server_bans" do
    field :reason, :string

    belongs_to :server, Vesper.Servers.Server
    belongs_to :user, Vesper.Accounts.User
    belongs_to :banned_by, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(server_ban, attrs) do
    server_ban
    |> cast(attrs, [:server_id, :user_id, :banned_by_id, :reason])
    |> validate_required([:server_id, :user_id])
    |> unique_constraint([:server_id, :user_id])
  end
end
