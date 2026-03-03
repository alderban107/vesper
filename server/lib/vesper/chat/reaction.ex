defmodule Vesper.Chat.Reaction do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "reactions" do
    field :emoji, :string
    field :ciphertext, :binary
    field :mls_epoch, :integer

    belongs_to :message, Vesper.Chat.Message
    belongs_to :sender, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(reaction, attrs) do
    reaction
    |> cast(attrs, [:emoji, :ciphertext, :mls_epoch, :message_id, :sender_id])
    |> validate_required([:emoji, :message_id, :sender_id])
    |> unique_constraint([:message_id, :sender_id, :emoji])
  end
end
