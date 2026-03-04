defmodule Vesper.Chat.Attachment do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "attachments" do
    field :filename, :string
    field :content_type, :string
    field :size_bytes, :integer
    field :storage_key, :string
    field :expires_at, :utc_datetime
    field :encrypted, :boolean, default: false

    belongs_to :message, Vesper.Chat.Message

    field :inserted_at, :utc_datetime
  end

  def changeset(attachment, attrs) do
    attachment
    |> cast(attrs, [
      :filename,
      :content_type,
      :size_bytes,
      :storage_key,
      :message_id,
      :expires_at,
      :encrypted
    ])
    |> validate_required([:filename, :storage_key])
  end
end
