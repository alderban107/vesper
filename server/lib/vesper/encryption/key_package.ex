defmodule Vesper.Encryption.KeyPackage do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "key_packages" do
    field :key_package_data, :binary
    field :consumed, :boolean, default: false

    belongs_to :user, Vesper.Accounts.User

    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(key_package, attrs) do
    key_package
    |> cast(attrs, [:key_package_data, :user_id, :consumed])
    |> validate_required([:key_package_data, :user_id])
  end
end
