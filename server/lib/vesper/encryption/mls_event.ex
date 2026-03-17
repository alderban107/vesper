defmodule Vesper.Encryption.MlsEvent do
  use Ecto.Schema
  import Ecto.Changeset

  @foreign_key_type :binary_id

  schema "mls_events" do
    field(:group_id, :string)
    field(:event_type, :string)
    field(:payload, :map, default: %{})
    field(:sender_device_id, :string)

    belongs_to(:sender, Vesper.Accounts.User)
    belongs_to(:channel, Vesper.Servers.Channel)
    belongs_to(:conversation, Vesper.Chat.DmConversation)

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(event, attrs) do
    event
    |> cast(attrs, [
      :group_id,
      :event_type,
      :payload,
      :sender_id,
      :sender_device_id,
      :channel_id,
      :conversation_id
    ])
    |> validate_required([:group_id, :event_type, :payload, :sender_id])
  end
end
