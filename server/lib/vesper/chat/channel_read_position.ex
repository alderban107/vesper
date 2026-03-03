defmodule Vesper.Chat.ChannelReadPosition do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "channel_read_positions" do
    belongs_to :user, Vesper.Accounts.User
    belongs_to :channel, Vesper.Servers.Channel
    belongs_to :last_read_message, Vesper.Chat.Message
    field :last_read_at, :utc_datetime
  end

  def changeset(position, attrs) do
    position
    |> cast(attrs, [:user_id, :channel_id, :last_read_message_id, :last_read_at])
    |> validate_required([:user_id, :channel_id])
    |> unique_constraint([:user_id, :channel_id])
  end
end
