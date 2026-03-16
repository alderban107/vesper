defmodule Vesper.Encryption.PendingWelcome do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_pending_welcomes" do
    field :welcome_data, :binary
    field :group_id, :string
    field :recipient_client_id, :string
    field :recipient_key_package_ref, :string

    belongs_to :recipient, Vesper.Accounts.User
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(welcome, attrs) do
    welcome
    |> cast(attrs, [
      :welcome_data,
      :group_id,
      :recipient_id,
      :recipient_client_id,
      :recipient_key_package_ref,
      :sender_id,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([:welcome_data, :group_id, :recipient_id, :sender_id])
  end
end
