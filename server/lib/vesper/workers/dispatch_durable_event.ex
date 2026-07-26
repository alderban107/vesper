defmodule Vesper.Workers.DispatchDurableEvent do
  use Oban.Worker,
    queue: :dispatch,
    max_attempts: 10,
    unique: [
      period: :infinity,
      fields: [:worker, :args],
      states: [:available, :scheduled, :retryable, :executing]
    ]

  alias Vesper.Dispatch

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"dispatch_id" => dispatch_id}}) do
    Dispatch.deliver(dispatch_id)
  end
end
