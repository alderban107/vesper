defmodule Vesper.Workers.ExpireMessages do
  @moduledoc """
  Oban worker that deletes messages past their expires_at timestamp.
  Runs every minute via crontab.
  """
  use Oban.Worker, queue: :default, max_attempts: 3
  require Logger

  alias Vesper.Chat

  @impl Oban.Worker
  def perform(_job) do
    {count, _} = Chat.delete_expired_messages()
    if count > 0, do: Logger.info("Deleted #{count} expired messages")
    :ok
  end
end
