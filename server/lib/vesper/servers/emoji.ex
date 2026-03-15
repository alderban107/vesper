defmodule Vesper.Servers.Emoji do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "server_emojis" do
    field :name, :string
    field :url, :string
    field :animated, :boolean, default: false
    field :storage_key, :string

    belongs_to :server, Vesper.Servers.Server

    timestamps(type: :utc_datetime)
  end

  def changeset(emoji, attrs) do
    emoji
    |> cast(attrs, [:id, :name, :url, :animated, :storage_key, :server_id])
    |> validate_required([:name, :url, :storage_key, :server_id])
    |> validate_format(:name, ~r/^[a-zA-Z0-9_~-]{2,32}$/)
    |> unique_constraint(:name, name: :server_emojis_server_id_name_index)
    |> foreign_key_constraint(:server_id)
  end
end
