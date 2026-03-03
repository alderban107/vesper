defmodule Vesper.Repo.Migrations.AddCiphertextToMessages do
  use Ecto.Migration

  def change do
    alter table(:messages) do
      add :ciphertext, :binary
    end

    # Make content nullable — encrypted messages have ciphertext instead
    execute "ALTER TABLE messages ALTER COLUMN content DROP NOT NULL",
            "ALTER TABLE messages ALTER COLUMN content SET NOT NULL"
  end
end
