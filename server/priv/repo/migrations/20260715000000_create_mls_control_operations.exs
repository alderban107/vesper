defmodule Vesper.Repo.Migrations.CreateMlsControlOperations do
  use Ecto.Migration

  def change do
    create table(:mls_control_operations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :actor_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :actor_client_id, :string, null: false
      add :scope_kind, :string, null: false
      add :scope_id, :string, null: false
      add :operation, :string, null: false
      add :idempotency_key, :string, null: false
      add :payload_hash, :binary, null: false
      add :state, :string, null: false, default: "pending"
      add :result, :map

      timestamps(type: :utc_datetime)
    end

    create unique_index(
             :mls_control_operations,
             [
               :actor_id,
               :actor_client_id,
               :scope_kind,
               :scope_id,
               :operation,
               :idempotency_key
             ],
             name: :mls_control_operations_idempotency_index
           )
  end
end
