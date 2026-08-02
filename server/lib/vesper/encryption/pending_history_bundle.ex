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
    field :request_id, Ecto.UUID
    field :membership_generation, :integer
    field :authorization_generation, Ecto.UUID
    field :authorized_after_room_seq, :integer

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
      :request_id,
      :membership_generation,
      :authorization_generation,
      :authorized_after_room_seq,
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
    |> validate_number(:mls_epoch, greater_than_or_equal_to: 0)
    |> validate_optional_non_negative(:membership_generation)
    |> validate_optional_non_negative(:authorized_after_room_seq)
    |> unique_constraint(:request_id,
      name: :mls_pending_history_bundles_bound_request_index
    )
    |> unique_constraint([:group_id, :recipient_id, :recipient_client_id, :sender_id],
      name: :mls_pending_history_bundles_unbound_recipient_sender_index
    )
  end

  defp validate_optional_non_negative(changeset, field) do
    case get_field(changeset, field) do
      nil -> changeset
      _value -> validate_number(changeset, field, greater_than_or_equal_to: 0)
    end
  end
end
