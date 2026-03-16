defmodule Vesper.Repo.Migrations.WidenPendingWelcomeKeyPackageRef do
  use Ecto.Migration

  def change do
    alter table(:mls_pending_welcomes) do
      modify :recipient_key_package_ref, :text
    end
  end
end
