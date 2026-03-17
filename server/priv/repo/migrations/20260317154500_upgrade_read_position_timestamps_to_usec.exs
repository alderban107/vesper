defmodule Vesper.Repo.Migrations.UpgradeReadPositionTimestampsToUsec do
  use Ecto.Migration

  def up do
    alter table(:channel_read_positions) do
      modify :last_read_at, :utc_datetime_usec, null: false, default: fragment("NOW()")
    end

    alter table(:dm_read_positions) do
      modify :last_read_at, :utc_datetime_usec, null: false, default: fragment("NOW()")
    end
  end

  def down do
    alter table(:channel_read_positions) do
      modify :last_read_at, :utc_datetime, null: false, default: fragment("NOW()")
    end

    alter table(:dm_read_positions) do
      modify :last_read_at, :utc_datetime, null: false, default: fragment("NOW()")
    end
  end
end
