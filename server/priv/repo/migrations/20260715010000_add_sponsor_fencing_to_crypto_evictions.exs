defmodule Vesper.Repo.Migrations.AddSponsorFencingToCryptoEvictions do
  use Ecto.Migration

  def change do
    alter table(:mls_pending_crypto_evictions) do
      add :membership_generation, :bigint, null: false, default: 0
      add :fencing_token, :bigint, null: false, default: 0
      add :lease_expires_at, :utc_datetime
      add :result, :map
    end

    create index(
             :mls_pending_crypto_evictions,
             [:scope_kind, :scope_id, :status, :lease_expires_at],
             name: :mls_crypto_evictions_lease_scan_index
           )
  end
end
