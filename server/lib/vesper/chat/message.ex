defmodule Vesper.Chat.Message do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "messages" do
    field :content, :string
    field :ciphertext, :binary
    field :client_nonce, :string
    field :mls_epoch, :integer
    field :encryption_scheme, :string, default: "mls"
    field :encryption_group_id, :string
    field :history_signing_public_key, :binary
    field :history_revision, :integer, default: 0
    field :expires_at, :utc_datetime
    field :edited_at, :utc_datetime
    field :is_reply, :boolean, default: false
    field :room_seq, :integer, virtual: true

    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :parent_message, Vesper.Chat.Message
    belongs_to :thread_root_message, Vesper.Chat.Message
    belongs_to :reply_to_message, Vesper.Chat.Message

    has_many :reactions, Vesper.Chat.Reaction
    has_many :attachments, Vesper.Chat.Attachment

    timestamps(type: :utc_datetime)
  end

  def changeset(message, attrs) do
    message
    |> cast(attrs, [
      :ciphertext,
      :client_nonce,
      :mls_epoch,
      :encryption_scheme,
      :encryption_group_id,
      :history_signing_public_key,
      :history_revision,
      :channel_id,
      :conversation_id,
      :sender_id,
      :expires_at,
      :parent_message_id,
      :thread_root_message_id,
      :reply_to_message_id,
      :edited_at,
      :is_reply
    ])
    |> validate_required([:ciphertext, :mls_epoch, :encryption_scheme, :sender_id])
    |> validate_number(:history_revision, greater_than_or_equal_to: 0)
    |> validate_history_signing_key()
    |> validate_target()
  end

  @doc false
  def encrypted_changeset(message, attrs) do
    message
    |> cast(attrs, [
      :ciphertext,
      :client_nonce,
      :mls_epoch,
      :encryption_scheme,
      :encryption_group_id,
      :history_signing_public_key,
      :history_revision,
      :channel_id,
      :conversation_id,
      :sender_id,
      :expires_at,
      :parent_message_id,
      :thread_root_message_id,
      :reply_to_message_id,
      :edited_at,
      :is_reply
    ])
    |> validate_required([:ciphertext, :mls_epoch, :encryption_scheme, :sender_id])
    |> validate_number(:history_revision, greater_than_or_equal_to: 0)
    |> validate_history_signing_key()
    |> validate_target()
  end

  defp validate_history_signing_key(changeset) do
    case get_field(changeset, :history_signing_public_key) do
      nil -> changeset
      key when byte_size(key) == 32 -> changeset
      _key -> add_error(changeset, :history_signing_public_key, "must be 32 bytes")
    end
  end

  defp validate_target(changeset) do
    channel_id = get_field(changeset, :channel_id)
    conversation_id = get_field(changeset, :conversation_id)

    case {channel_id, conversation_id} do
      {nil, nil} ->
        add_error(changeset, :channel_id, "must belong to a channel or conversation")

      {_, nil} ->
        changeset

      {nil, _} ->
        changeset

      {_, _} ->
        add_error(changeset, :channel_id, "cannot belong to both a channel and conversation")
    end
  end
end
