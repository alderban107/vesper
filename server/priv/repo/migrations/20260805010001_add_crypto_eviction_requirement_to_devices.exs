defmodule Vesper.Repo.Migrations.AddCryptoEvictionRequirementToDevices do
  use Ecto.Migration

  def change do
    alter table(:devices) do
      add :crypto_eviction_required_at, :utc_datetime
    end
  end
end
