defmodule Vesper.Servers.AuditLog do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "audit_logs" do
    field :action, :string
    field :target_id, :string
    field :metadata, :map, default: %{}

    belongs_to :server, Vesper.Servers.Server
    belongs_to :actor, Vesper.Accounts.User
    belongs_to :target_user, Vesper.Accounts.User

    timestamps(type: :utc_datetime)
  end

  def changeset(audit_log, attrs) do
    audit_log
    |> cast(attrs, [:server_id, :actor_id, :target_user_id, :action, :target_id, :metadata])
    |> validate_required([:server_id, :action])
  end
end
