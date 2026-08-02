defmodule Vesper.Dispatch do
  import Ecto.Query

  alias Vesper.DispatchOutbox
  alias Vesper.Repo
  alias Vesper.Workers.DispatchDurableEvent

  @dead_letter_attempts 10

  def enqueue(attrs) do
    changeset = DispatchOutbox.changeset(%DispatchOutbox{}, attrs)

    with {:ok, dispatch} <-
           Repo.insert(changeset, on_conflict: :nothing, conflict_target: :durable_key),
         dispatch <- resolve_inserted_dispatch(dispatch, attrs),
         {:ok, _job} <- Oban.insert(DispatchDurableEvent.new(%{"dispatch_id" => dispatch.id})) do
      {:ok, dispatch}
    end
  end

  def deliver(dispatch_id, broadcast_fn \\ &broadcast/3) do
    Repo.transaction(fn ->
      dispatch =
        from(item in DispatchOutbox, where: item.id == ^dispatch_id, lock: "FOR UPDATE")
        |> Repo.one()

      cond do
        is_nil(dispatch) ->
          :ok

        dispatch.status in ["delivered", "dead"] ->
          :ok

        earlier_pending?(dispatch) ->
          Repo.rollback(:waiting_for_scope_order)

        true ->
          attempt_delivery(dispatch, broadcast_fn)
      end
    end)
    |> case do
      {:ok, result} -> result
      {:error, :waiting_for_scope_order} -> {:snooze, 1}
      {:error, reason} -> {:error, reason}
    end
  end

  def backlog_metrics(now \\ DateTime.utc_now()) do
    pending =
      from(item in DispatchOutbox,
        where: item.status in ["pending", "failed"],
        select: {count(item.id), min(item.inserted_at), coalesce(sum(item.attempt_count), 0)}
      )
      |> Repo.one()

    {depth, oldest_at, attempts} = pending || {0, nil, 0}

    failures =
      Repo.aggregate(
        from(item in DispatchOutbox, where: item.status in ["failed", "dead"]),
        :count
      )

    %{
      depth: depth,
      oldest_age_seconds: if(oldest_at, do: max(DateTime.diff(now, oldest_at), 0), else: 0),
      attempts: attempts,
      failures: failures
    }
  end

  def emit_backlog_metrics do
    metrics = backlog_metrics()
    :telemetry.execute([:vesper, :dispatch, :backlog], metrics, %{})
    metrics
  end

  defp resolve_inserted_dispatch(%DispatchOutbox{id: nil}, attrs) do
    Repo.get_by!(DispatchOutbox, durable_key: Map.fetch!(attrs, :durable_key))
  end

  defp resolve_inserted_dispatch(dispatch, _attrs), do: dispatch

  defp earlier_pending?(dispatch) do
    from(item in DispatchOutbox,
      where:
        item.scope_key == ^dispatch.scope_key and
          item.status in ["pending", "failed"] and
          item.ordering_key < ^dispatch.ordering_key,
      select: 1,
      limit: 1
    )
    |> Repo.exists?()
  end

  defp attempt_delivery(dispatch, broadcast_fn) do
    attempts = dispatch.attempt_count + 1

    try do
      payload = Map.put(dispatch.payload || %{}, "dispatch_id", dispatch.durable_key)
      :ok = broadcast_fn.(dispatch.scope_topic, dispatch.event, payload)
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      dispatch
      |> DispatchOutbox.changeset(%{
        status: "delivered",
        attempt_count: attempts,
        delivered_at: now,
        last_error: nil
      })
      |> Repo.update!()

      :telemetry.execute([:vesper, :dispatch, :delivered], %{attempts: attempts}, %{
        event: dispatch.event
      })

      :ok
    rescue
      error ->
        record_failure(dispatch, attempts, Exception.message(error))
    end
  end

  defp record_failure(dispatch, attempts, error) do
    dead? = attempts >= @dead_letter_attempts
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    dispatch
    |> DispatchOutbox.changeset(%{
      status: if(dead?, do: "dead", else: "failed"),
      attempt_count: attempts,
      dead_lettered_at: if(dead?, do: now, else: nil),
      last_error: error
    })
    |> Repo.update!()

    :telemetry.execute([:vesper, :dispatch, :failed], %{attempts: attempts}, %{
      event: dispatch.event,
      dead_lettered: dead?
    })

    if dead?, do: :ok, else: {:error, error}
  end

  defp broadcast(topic, event, payload) do
    VesperWeb.Endpoint.broadcast(topic, event, payload)
    :ok
  end
end
