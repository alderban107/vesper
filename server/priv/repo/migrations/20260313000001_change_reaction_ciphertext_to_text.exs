defmodule Vesper.Repo.Migrations.ChangeReactionCiphertextToText do
  use Ecto.Migration

  def change do
    alter table(:reactions) do
      modify :ciphertext, :text, from: :binary
    end
  end
end
