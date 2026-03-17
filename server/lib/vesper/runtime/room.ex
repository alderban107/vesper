defmodule Vesper.Runtime.Room do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "rooms" do
    field :kind, Ecto.Enum, values: [:channel, :dm]
    field :current_seq, :integer, default: 0
    field :last_message_at, :utc_datetime
    field :last_message_seq, :integer
    field :last_mutation_at, :utc_datetime
    field :last_mutation_seq, :integer

    belongs_to :server, Vesper.Servers.Server
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation
    belongs_to :last_message, Vesper.Chat.Message

    timestamps(type: :utc_datetime)
  end

  def changeset(room, attrs) do
    room
    |> cast(attrs, [
      :kind,
      :server_id,
      :channel_id,
      :conversation_id,
      :current_seq,
      :last_message_id,
      :last_message_at,
      :last_message_seq,
      :last_mutation_at,
      :last_mutation_seq
    ])
    |> validate_required([:kind])
    |> validate_binding()
  end

  defp validate_binding(changeset) do
    kind = get_field(changeset, :kind)
    channel_id = get_field(changeset, :channel_id)
    conversation_id = get_field(changeset, :conversation_id)

    case {kind, channel_id, conversation_id} do
      {:channel, channel_id, nil} when not is_nil(channel_id) -> changeset
      {:dm, nil, conversation_id} when not is_nil(conversation_id) -> changeset
      _ -> add_error(changeset, :kind, "must match room binding")
    end
  end
end
