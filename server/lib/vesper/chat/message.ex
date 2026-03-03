defmodule Vesper.Chat.Message do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "messages" do
    field :content, :string
    field :ciphertext, :binary
    field :mls_epoch, :integer
    field :expires_at, :utc_datetime
    field :edited_at, :utc_datetime

    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :parent_message, Vesper.Chat.Message

    has_many :reactions, Vesper.Chat.Reaction
    has_many :attachments, Vesper.Chat.Attachment

    timestamps(type: :utc_datetime)
  end

  def changeset(message, attrs) do
    message
    |> cast(attrs, [:ciphertext, :mls_epoch, :channel_id, :conversation_id, :sender_id, :expires_at, :parent_message_id, :edited_at])
    |> validate_required([:ciphertext, :mls_epoch, :sender_id])
    |> validate_target()
  end

  @doc false
  def encrypted_changeset(message, attrs) do
    message
    |> cast(attrs, [:ciphertext, :mls_epoch, :channel_id, :conversation_id, :sender_id, :expires_at, :parent_message_id, :edited_at])
    |> validate_required([:ciphertext, :mls_epoch, :sender_id])
    |> validate_target()
  end

  defp validate_target(changeset) do
    channel_id = get_field(changeset, :channel_id)
    conversation_id = get_field(changeset, :conversation_id)

    case {channel_id, conversation_id} do
      {nil, nil} -> add_error(changeset, :channel_id, "must belong to a channel or conversation")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :channel_id, "cannot belong to both a channel and conversation")
    end
  end
end
