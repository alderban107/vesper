defmodule Vesper.Repo.Migrations.AddNotificationFieldsToDevices do
  use Ecto.Migration

  def change do
    alter table(:devices) do
      add :push_token, :text
      add :push_platform, :string, size: 32
      add :notification_public_key, :binary
      add :background_sync_capable, :boolean, null: false, default: false
    end
  end
end
