defmodule Vesper.Chat.PinnedMessage do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "pinned_messages" do
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :message, Vesper.Chat.Message
    belongs_to :pinned_by, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(pinned_message, attrs) do
    pinned_message
    |> cast(attrs, [:channel_id, :message_id, :pinned_by_id])
    |> validate_required([:channel_id, :message_id, :pinned_by_id])
    |> unique_constraint([:channel_id, :message_id])
  end
end
