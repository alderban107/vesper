defmodule Vesper.Encryption.PendingHistoryBundle do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_pending_history_bundles" do
    field :group_id, :string
    field :ciphertext, :string
    field :mls_epoch, :integer
    field :recipient_client_id, :string

    belongs_to :recipient, Vesper.Accounts.User
    belongs_to :sender, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(bundle, attrs) do
    bundle
    |> cast(attrs, [
      :group_id,
      :ciphertext,
      :mls_epoch,
      :recipient_id,
      :recipient_client_id,
      :sender_id,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([
      :group_id,
      :ciphertext,
      :mls_epoch,
      :recipient_id,
      :recipient_client_id,
      :sender_id
    ])
    |> unique_constraint([:group_id, :recipient_id, :recipient_client_id, :sender_id],
      name: :mls_pending_history_bundles_group_recipient_sender_index
    )
  end
end
