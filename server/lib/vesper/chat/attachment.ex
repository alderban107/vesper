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
    belongs_to :uploader, Vesper.Accounts.User

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
      :encrypted,
      :uploader_id
    ])
    |> validate_required([:filename, :storage_key])
    |> validate_length(:filename, min: 1, max: 255)
    |> validate_length(:content_type, max: 255)
    |> validate_length(:storage_key, min: 1, max: 512)
    |> validate_number(:size_bytes, greater_than_or_equal_to: 0)
    |> validate_safe_text(:filename)
    |> validate_safe_text(:content_type)
  end

  defp validate_safe_text(changeset, field) do
    validate_change(changeset, field, fn ^field, value ->
      cond do
        not String.valid?(value) ->
          [{field, "must be valid UTF-8"}]

        String.match?(value, ~r/[\x00-\x1F\x7F]/u) ->
          [{field, "must not contain control characters"}]

        true ->
          []
      end
    end)
  end
end
