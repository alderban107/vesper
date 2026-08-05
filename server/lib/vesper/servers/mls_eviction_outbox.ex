defmodule Vesper.Servers.MlsEvictionOutbox do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @statuses ~w(pending handed_off cancelled)
  @causes ~w(membership_removed device_revoked)

  schema "mls_eviction_outbox" do
    field :scope_kind, :string
    field :scope_id, :string
    field :group_id, :string
    field :target_device_id, :string
    field :cause, :string
    field :status, :string, default: "pending"
    field :reason, :string
    field :attempt_count, :integer, default: 0
    field :last_error, :string
    field :handed_off_at, :utc_datetime
    field :cancelled_at, :utc_datetime

    belongs_to :server, Vesper.Servers.Server
    belongs_to :target_user, Vesper.Accounts.User
    belongs_to :device, Vesper.Accounts.Device

    timestamps(type: :utc_datetime)
  end

  def statuses, do: @statuses

  def changeset(outbox, attrs) do
    outbox
    |> cast(attrs, [
      :scope_kind,
      :scope_id,
      :group_id,
      :server_id,
      :target_user_id,
      :device_id,
      :target_device_id,
      :cause,
      :status,
      :reason,
      :attempt_count,
      :last_error,
      :handed_off_at,
      :cancelled_at
    ])
    |> validate_required([
      :scope_kind,
      :scope_id,
      :group_id,
      :target_user_id,
      :device_id,
      :target_device_id,
      :cause,
      :status
    ])
    |> validate_inclusion(:status, @statuses)
    |> validate_inclusion(:cause, @causes)
    |> check_constraint(:reason, name: :mls_eviction_outbox_reason_check)
    |> unique_constraint([:server_id, :target_user_id, :target_device_id, :scope_kind, :scope_id],
      name: :mls_eviction_outbox_active_scope_device_index
    )
  end
end
