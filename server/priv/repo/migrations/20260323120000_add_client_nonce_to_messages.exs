defmodule Vesper.Repo.Migrations.AddClientNonceToMessages do
  use Ecto.Migration

  def change do
    alter table(:messages) do
      add :client_nonce, :string
    end
  end
end
