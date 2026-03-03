defmodule Vesper.Servers.Channel do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "channels" do
    field :name, :string
    field :type, :string, default: "text"
    field :topic, :string
    field :position, :integer, default: 0
    field :disappearing_ttl, :integer

    belongs_to :server, Vesper.Servers.Server
    has_many :messages, Vesper.Chat.Message

    timestamps(type: :utc_datetime)
  end

  def changeset(channel, attrs) do
    channel
    |> cast(attrs, [:name, :type, :topic, :position, :disappearing_ttl])
    |> validate_required([:name, :type])
    |> validate_length(:name, min: 1, max: 100)
    |> validate_inclusion(:type, ~w(text voice))
  end
end
