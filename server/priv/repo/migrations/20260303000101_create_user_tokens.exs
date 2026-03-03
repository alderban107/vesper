defmodule Vesper.Repo.Migrations.CreateUserTokens do
  use Ecto.Migration

  def change do
    create table(:user_tokens, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :token, :binary, null: false
      add :context, :string, size: 32, null: false
      add :device_name, :string, size: 128
      add :sent_to, :string, size: 255

      add :inserted_at, :utc_datetime, null: false, default: fragment("now()")
    end

    create unique_index(:user_tokens, [:token])
    create index(:user_tokens, [:user_id])
  end
end
