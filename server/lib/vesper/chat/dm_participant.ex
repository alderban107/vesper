defmodule Vesper.Chat.DmParticipant do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "dm_participants" do
    belongs_to :conversation, Vesper.Chat.DmConversation
    belongs_to :user, Vesper.Accounts.User

    field :joined_at, :utc_datetime
  end

  def changeset(participant, attrs) do
    participant
    |> cast(attrs, [:conversation_id, :user_id])
    |> validate_required([:conversation_id, :user_id])
    |> unique_constraint([:conversation_id, :user_id])
  end
end
