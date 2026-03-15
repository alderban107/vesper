defmodule Vesper.Accounts.SearchIndexSnapshot do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "search_index_snapshots" do
    field(:device_id, :string)
    field(:version, :integer)
    field(:ciphertext, :binary)
    field(:nonce, :binary)

    belongs_to(:user, Vesper.Accounts.User)

    timestamps(type: :utc_datetime)
  end

  def changeset(snapshot, attrs) do
    snapshot
    |> cast(attrs, [:user_id, :device_id, :version, :ciphertext, :nonce])
    |> validate_required([:user_id, :device_id, :version, :ciphertext, :nonce])
    |> validate_number(:version, greater_than: 0)
    |> unique_constraint(:user_id)
  end
end
