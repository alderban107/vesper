defmodule Vesper.Encryption.PendingHistoryRequest do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_pending_history_requests" do
    field :group_id, :string
    field :requester_client_id, :string
    field :requester_username, :string
    field :membership_generation, :integer

    belongs_to :requester, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(request, attrs) do
    request
    |> cast(attrs, [
      :group_id,
      :requester_id,
      :requester_client_id,
      :requester_username,
      :membership_generation,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([
      :group_id,
      :requester_id,
      :requester_client_id,
      :membership_generation
    ])
    |> validate_number(:membership_generation, greater_than_or_equal_to: 0)
    |> unique_constraint([:group_id, :requester_id, :requester_client_id],
      name: :mls_pending_history_requests_group_id_requester_id_requester_client_id_index
    )
  end
end
