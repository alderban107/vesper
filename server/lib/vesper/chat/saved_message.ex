defmodule Vesper.Chat.SavedMessage do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "saved_messages" do
    belongs_to :user, Vesper.Accounts.User
    belongs_to :message, Vesper.Chat.Message
    belongs_to :channel, Vesper.Servers.Channel

    field :note, :string

    timestamps(type: :utc_datetime)
  end

  def changeset(saved_message, attrs) do
    saved_message
    |> cast(attrs, [:user_id, :message_id, :channel_id, :note])
    |> validate_required([:user_id, :message_id])
    |> unique_constraint([:user_id, :message_id])
  end
end
