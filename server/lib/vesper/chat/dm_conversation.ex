defmodule Vesper.Chat.DmConversation do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "dm_conversations" do
    field :type, :string, default: "direct"
    field :name, :string
    field :disappearing_ttl, :integer

    has_many :participants, Vesper.Chat.DmParticipant, foreign_key: :conversation_id
    has_many :users, through: [:participants, :user]
    has_many :messages, Vesper.Chat.Message, foreign_key: :conversation_id

    belongs_to :channel, Vesper.Servers.Channel

    field :inserted_at, :utc_datetime
  end

  def changeset(conversation, attrs) do
    conversation
    |> cast(attrs, [:type, :name, :disappearing_ttl])
    |> validate_required([:type])
    |> validate_inclusion(:type, ~w(direct group))
    |> validate_length(:name, max: 100)
    |> validate_change(:name, fn :name, name ->
      cond do
        not String.valid?(name) ->
          [name: "must be valid UTF-8"]

        String.match?(name, ~r/[\x00-\x1F\x7F]/u) ->
          [name: "must not contain control characters"]

        true ->
          []
      end
    end)
  end
end
