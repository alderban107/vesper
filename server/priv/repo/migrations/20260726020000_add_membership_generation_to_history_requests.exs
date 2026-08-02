defmodule Vesper.Repo.Migrations.AddMembershipGenerationToHistoryRequests do
  use Ecto.Migration

  def change do
    alter table(:mls_pending_history_requests) do
      add :membership_generation, :integer, null: false, default: 0
    end
  end
end
