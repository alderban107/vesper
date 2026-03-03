defmodule Vesper.Encryption.PendingWelcome do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_pending_welcomes" do
    field :welcome_data, :binary

    belongs_to :recipient, Vesper.Accounts.User
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(welcome, attrs) do
    welcome
    |> cast(attrs, [:welcome_data, :recipient_id, :sender_id, :channel_id, :conversation_id])
    |> validate_required([:welcome_data, :recipient_id, :sender_id])
  end
end
