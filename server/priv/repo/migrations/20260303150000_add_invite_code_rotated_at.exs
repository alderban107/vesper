defmodule Vesper.Repo.Migrations.AddInviteCodeRotatedAt do
  use Ecto.Migration

  def change do
    alter table(:servers) do
      add :invite_code_rotated_at, :utc_datetime, default: fragment("now()")
    end
  end
end
