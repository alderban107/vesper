defmodule Vesper.Repo.Migrations.AddMembershipScopeCheckConstraint do
  use Ecto.Migration

  def change do
    # Enforce that every membership has exactly one of server_id or channel_id set.
    # Server memberships: server_id is set, channel_id is null.
    # DM channel memberships: channel_id is set, server_id is null.
    create constraint(:memberships, :memberships_scope_check,
      check: "num_nonnulls(server_id, channel_id) = 1"
    )
  end
end
