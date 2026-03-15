defmodule Vesper.Encryption.PendingResyncRequest do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_pending_resync_requests" do
    field :group_id, :string
    field :request_id, :string
    field :requester_username, :string
    field :last_known_epoch, :integer
    field :reason, :string

    belongs_to :requester, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(request, attrs) do
    request
    |> cast(attrs, [
      :group_id,
      :request_id,
      :requester_id,
      :requester_username,
      :last_known_epoch,
      :reason,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([:group_id, :request_id, :requester_id])
    |> unique_constraint([:group_id, :requester_id],
      name: :mls_pending_resync_requests_group_id_requester_id_index
    )
  end
end
