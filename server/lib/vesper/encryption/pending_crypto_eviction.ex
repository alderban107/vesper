defmodule Vesper.Encryption.PendingCryptoEviction do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @statuses ~w(pending requested claimed committed applied failed)

  schema "mls_pending_crypto_evictions" do
    field :scope_kind, :string
    field :scope_id, :string
    field :group_id, :string
    field :reason, :string
    field :status, :string, default: "pending"
    field :attempt_count, :integer, default: 0
    field :last_error, :string
    field :target_device_id, :string
    field :sponsor_device_id, :string
    field :requested_at, :utc_datetime
    field :claimed_at, :utc_datetime
    field :committed_at, :utc_datetime
    field :applied_at, :utc_datetime

    belongs_to :server, Vesper.Servers.Server
    belongs_to :target_user, Vesper.Accounts.User
    belongs_to :sponsor_user, Vesper.Accounts.User
    belongs_to :commit_event, Vesper.Encryption.MlsEvent, type: :id

    timestamps(type: :utc_datetime)
  end

  def changeset(eviction, attrs) do
    eviction
    |> cast(attrs, [
      :scope_kind,
      :scope_id,
      :group_id,
      :server_id,
      :target_user_id,
      :target_device_id,
      :reason,
      :status,
      :attempt_count,
      :last_error,
      :sponsor_user_id,
      :sponsor_device_id,
      :requested_at,
      :claimed_at,
      :committed_at,
      :applied_at,
      :commit_event_id
    ])
    |> validate_required([
      :scope_kind,
      :scope_id,
      :group_id,
      :server_id,
      :target_user_id,
      :status
    ])
    |> validate_inclusion(:status, @statuses)
  end
end
