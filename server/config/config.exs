# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :vesper,
  ecto_repos: [Vesper.Repo],
  generators: [timestamp_type: :utc_datetime, binary_id: true],
  sync_event_retention_days: 7,
  multi_cohort_topology_mutations_enabled: false

# Configure the endpoint
config :vesper, VesperWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: VesperWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Vesper.PubSub,
  live_view: [signing_salt: "TzvFhVFl"]

# Configure the mailer
#
# By default it uses the "Local" adapter which stores the emails
# locally. You can see the emails in your browser, at "/dev/mailbox".
#
# For production it's recommended to configure a different adapter
# at the `config/runtime.exs`.
config :vesper, Vesper.Mailer, adapter: Swoosh.Adapters.Local

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Joken JWT config
config :joken,
  default_signer: [
    signer_alg: "HS256",
    key_octet: "dev-secret-change-in-production-must-be-at-least-32-bytes!"
  ]

# Oban background jobs
config :vesper, Oban,
  repo: Vesper.Repo,
  queues: [default: 10, crypto_evictions: 20, dispatch: 50],
  plugins: [
    {Oban.Plugins.Cron,
     crontab: [
       {"* * * * *", Vesper.Workers.ExpireMessages},
       {"0 3 * * *", Vesper.Workers.PurgeKeyPackages},
       {"0 3 * * *", Vesper.Workers.PurgeWelcomes},
       {"0 3 * * *", Vesper.Workers.PurgeRecoveryMaterial},
       {"0 3 * * *", Vesper.Workers.ExpireAttachmentBlobs},
       {"0 3 * * *", Vesper.Workers.PurgeExpiredTokens},
       {"0 4 * * *", Vesper.Workers.PurgeSyncEvents}
     ]}
  ]

# ICE servers for WebRTC voice
config :vesper, :ice_servers, [
  %{urls: "stun:stun.l.google.com:19302"}
]

config :vesper, :ice_transport_policy, "all"

# Hammer rate limiting
config :hammer,
  backend: {Hammer.Backend.ETS, [expiry_ms: 60_000 * 10, cleanup_interval_ms: 60_000 * 10]}

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
