defmodule VesperWeb.Telemetry do
  use Supervisor
  import Telemetry.Metrics

  def start_link(arg) do
    Supervisor.start_link(__MODULE__, arg, name: __MODULE__)
  end

  @impl true
  def init(_arg) do
    children = [
      {TelemetryMetricsPrometheus.Core, metrics: prometheus_metrics(), start_async: false},
      {:telemetry_poller, measurements: periodic_measurements(), period: 10_000}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  def metrics do
    [
      # Phoenix Metrics
      summary("phoenix.endpoint.start.system_time",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.endpoint.stop.duration",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.start.system_time",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.exception.duration",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.stop.duration",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.socket_connected.duration",
        unit: {:native, :millisecond}
      ),
      sum("phoenix.socket_drain.count"),
      summary("phoenix.channel_joined.duration",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.channel_handled_in.duration",
        tags: [:event],
        unit: {:native, :millisecond}
      ),

      # Database Metrics
      summary("vesper.repo.query.total_time",
        unit: {:native, :millisecond},
        description: "The sum of the other measurements"
      ),
      summary("vesper.repo.query.decode_time",
        unit: {:native, :millisecond},
        description: "The time spent decoding the data received from the database"
      ),
      summary("vesper.repo.query.query_time",
        unit: {:native, :millisecond},
        description: "The time spent executing the query"
      ),
      summary("vesper.repo.query.queue_time",
        unit: {:native, :millisecond},
        description: "The time spent waiting for a database connection"
      ),
      summary("vesper.repo.query.idle_time",
        unit: {:native, :millisecond},
        description:
          "The time the connection spent waiting before being checked out for the query"
      ),

      # VM Metrics
      summary("vm.memory.total", unit: {:byte, :kilobyte}),
      summary("vm.total_run_queue_lengths.total"),
      summary("vm.total_run_queue_lengths.cpu"),
      summary("vm.total_run_queue_lengths.io"),

      # Vesper Custom Metrics

      # Chat message send
      counter("vesper.chat.message.send.count"),
      distribution("vesper.chat.message.send.duration",
        unit: {:native, :millisecond}
      ),

      # Notification fanout
      counter("vesper.chat.notification.fanout.count"),

      # Voice room operations
      counter("vesper.voice.room.join.count"),
      counter("vesper.voice.room.leave.count"),
      distribution("vesper.voice.room.join.duration",
        unit: {:native, :millisecond}
      ),

      # Member cache
      counter("vesper.member_cache.miss.count"),

      # Durable realtime dispatch
      counter("vesper.dispatch.delivered.count"),
      counter("vesper.dispatch.failed.count", tags: [:event, :dead_lettered]),
      last_value("vesper.dispatch.backlog.depth"),
      last_value("vesper.dispatch.backlog.oldest_age_seconds"),
      last_value("vesper.dispatch.backlog.attempts"),
      last_value("vesper.dispatch.backlog.failures")
    ]
  end

  def prometheus_metrics do
    latency_buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]

    [
      distribution("vesper.http.request.duration.seconds",
        event_name: [:phoenix, :router_dispatch, :stop],
        measurement: :duration,
        tags: [:route],
        unit: {:native, :second},
        reporter_options: [buckets: latency_buckets]
      ),
      counter("vesper.http.request.exception.count",
        event_name: [:phoenix, :router_dispatch, :exception],
        tags: [:route]
      ),
      distribution("vesper.database.query.duration.seconds",
        event_name: [:vesper, :repo, :query],
        measurement: :total_time,
        unit: {:native, :second},
        reporter_options: [buckets: latency_buckets]
      ),
      counter("vesper.chat.message.send.count",
        event_name: [:vesper, :chat, :message, :send]
      ),
      distribution("vesper.chat.message.send.duration.seconds",
        event_name: [:vesper, :chat, :message, :send],
        measurement: :duration,
        unit: {:native, :second},
        reporter_options: [buckets: latency_buckets]
      ),
      counter("vesper.voice.room.join.count",
        event_name: [:vesper, :voice, :room, :join]
      ),
      counter("vesper.voice.room.leave.count",
        event_name: [:vesper, :voice, :room, :leave]
      ),
      counter("vesper.member.cache.miss.count",
        event_name: [:vesper, :member_cache, :miss]
      ),
      counter("vesper.dispatch.delivered.count",
        event_name: [:vesper, :dispatch, :delivered]
      ),
      counter("vesper.dispatch.failed.count",
        event_name: [:vesper, :dispatch, :failed],
        tags: [:event, :dead_lettered]
      ),
      last_value("vesper.dispatch.backlog.depth",
        event_name: [:vesper, :dispatch, :backlog],
        measurement: :depth
      ),
      last_value("vesper.dispatch.backlog.oldest.age.seconds",
        event_name: [:vesper, :dispatch, :backlog],
        measurement: :oldest_age_seconds
      ),
      last_value("vesper.dispatch.backlog.failures",
        event_name: [:vesper, :dispatch, :backlog],
        measurement: :failures
      )
    ]
  end

  defp periodic_measurements do
    if Application.get_env(:vesper, :dispatch_metrics_polling_enabled, true) do
      [{Vesper.Dispatch, :emit_backlog_metrics, []}]
    else
      []
    end
  end
end
