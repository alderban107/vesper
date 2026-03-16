defmodule Vesper.Repo.Migrations.DeduplicateAndScopePendingWelcomes do
  use Ecto.Migration

  def up do
    execute("""
    DELETE FROM mls_pending_welcomes
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY recipient_id, group_id, COALESCE(recipient_client_id, '')
                 ORDER BY inserted_at DESC, id DESC
               ) AS row_number
        FROM mls_pending_welcomes
      ) duplicates
      WHERE duplicates.row_number > 1
    )
    """)

    create unique_index(:mls_pending_welcomes, [:recipient_id, :group_id],
             where: "recipient_client_id IS NULL",
             name: :mls_pending_welcomes_scope_unique_index
           )

    create unique_index(:mls_pending_welcomes, [:recipient_id, :group_id, :recipient_client_id],
             where: "recipient_client_id IS NOT NULL",
             name: :mls_pending_welcomes_device_unique_index
           )
  end

  def down do
    drop_if_exists index(:mls_pending_welcomes, [:recipient_id, :group_id],
                     where: "recipient_client_id IS NULL",
                     name: :mls_pending_welcomes_scope_unique_index
                   )

    drop_if_exists index(:mls_pending_welcomes, [:recipient_id, :group_id, :recipient_client_id],
                     where: "recipient_client_id IS NOT NULL",
                     name: :mls_pending_welcomes_device_unique_index
                   )
  end
end
