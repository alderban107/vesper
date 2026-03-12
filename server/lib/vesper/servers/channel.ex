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
    belongs_to :category, __MODULE__
    has_many :children, __MODULE__, foreign_key: :category_id
    has_many :messages, Vesper.Chat.Message

    timestamps(type: :utc_datetime)
  end

  def changeset(channel, attrs) do
    channel
    |> cast(attrs, [:name, :type, :topic, :position, :disappearing_ttl, :category_id])
    |> validate_required([:name, :type])
    |> validate_length(:name, min: 1, max: 100)
    |> validate_inclusion(:type, ~w(text voice category))
    |> validate_category_rules()
  end

  defp validate_category_rules(changeset) do
    case get_field(changeset, :type) do
      "category" ->
        changeset
        |> put_change(:category_id, nil)
        |> put_change(:topic, nil)
        |> put_change(:disappearing_ttl, nil)

      _ ->
        changeset
    end
  end
end
