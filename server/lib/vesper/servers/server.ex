defmodule Vesper.Servers.Server do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "servers" do
    field :name, :string
    field :icon_url, :string
    field :invite_code, :string
    field :invite_code_rotated_at, :utc_datetime

    belongs_to :owner, Vesper.Accounts.User
    has_many :channels, Vesper.Servers.Channel
    has_many :memberships, Vesper.Servers.Membership

    timestamps(type: :utc_datetime)
  end

  def changeset(server, attrs) do
    server
    |> cast(attrs, [:name, :icon_url])
    |> validate_required([:name])
    |> validate_length(:name, min: 1, max: 100)
    |> maybe_generate_invite_code()
  end

  defp maybe_generate_invite_code(changeset) do
    case get_field(changeset, :invite_code) do
      nil ->
        changeset
        |> put_change(:invite_code, generate_invite_code())
        |> put_change(:invite_code_rotated_at, DateTime.utc_now() |> DateTime.truncate(:second))

      _ ->
        changeset
    end
  end

  def generate_invite_code do
    :crypto.strong_rand_bytes(8) |> Base.url_encode64(padding: false) |> String.slice(0, 8)
  end
end
