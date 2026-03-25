defmodule Vesper.Repo.Migrations.AddMessageNonceUniqueIndexes do
  use Ecto.Migration

  def change do
    # Partial unique indexes for idempotent message sends.
    # Only active when client_nonce is provided (not null).
    # Prevents duplicate messages from client retries.
    create unique_index(:messages, [:channel_id, :sender_id, :client_nonce],
             where: "client_nonce IS NOT NULL AND channel_id IS NOT NULL",
             name: :messages_channel_nonce_idx
           )

    create unique_index(:messages, [:conversation_id, :sender_id, :client_nonce],
             where: "client_nonce IS NOT NULL AND conversation_id IS NOT NULL",
             name: :messages_conversation_nonce_idx
           )
  end
end
