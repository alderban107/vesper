defmodule Vesper.Repo.Migrations.AllowNonServerPendingCryptoEvictions do
  use Ecto.Migration

  def change do
    alter table(:mls_pending_crypto_evictions) do
      modify :server_id, references(:servers, type: :binary_id, on_delete: :delete_all),
        null: true,
        from: references(:servers, type: :binary_id, on_delete: :delete_all)
    end
  end
end
