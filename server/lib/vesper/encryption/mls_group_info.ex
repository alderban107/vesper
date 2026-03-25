defmodule Vesper.Encryption.MlsGroupInfo do
  @moduledoc """
  Stores the latest MLS GroupInfo for a scope, enabling External Commits (RFC 9420 §12.4).

  After each epoch change (add, remove, update), a group member publishes the new GroupInfo
  to this table. New members fetch it and self-join via External Commit — no existing member
  needs to be online.

  Only the latest GroupInfo per scope is stored (upsert on group_id).
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mls_group_info" do
    field :group_id, :string
    field :group_info_data, :binary
    field :ratchet_tree_data, :binary
    field :epoch, :integer
    field :publisher_client_id, :string

    belongs_to :publisher, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :conversation, Vesper.Chat.DmConversation

    timestamps(type: :utc_datetime)
  end

  def changeset(group_info, attrs) do
    group_info
    |> cast(attrs, [
      :group_id,
      :group_info_data,
      :ratchet_tree_data,
      :epoch,
      :publisher_id,
      :publisher_client_id,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([:group_id, :group_info_data, :epoch, :publisher_id])
    |> unique_constraint(:group_id)
  end
end
