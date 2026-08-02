import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :vesper, Vesper.Repo,
  username: System.get_env("TEST_DB_USER", "postgres"),
  password: System.get_env("TEST_DB_PASS", "postgres"),
  hostname: System.get_env("TEST_DB_HOST", "localhost"),
  port: String.to_integer(System.get_env("TEST_DB_PORT", "5432")),
  database: "vesper_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size:
    String.to_integer(
      System.get_env("TEST_DB_POOL_SIZE", Integer.to_string(System.schedulers_online() * 2))
    )

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :vesper, VesperWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "pmAh2yYe5qf7WVd49tkCEmeYlDdtoRnFFy7ZC6eoPMAqiCWItAIV5fRcCN7PsQI4",
  server: false

# In test we don't send emails
config :vesper, Vesper.Mailer, adapter: Swoosh.Adapters.Test

# Disable swoosh api client as it is only required for production adapters
config :swoosh, :api_client, false

# Disable Oban in test
config :vesper, Oban, testing: :inline
config :vesper, run_migrations_on_start: false
config :vesper, :metrics_token, String.duplicate("test-metrics-token-", 2)
config :vesper, :dispatch_metrics_polling_enabled, false
config :vesper, warm_room_cache_on_start: false
config :vesper, :multi_cohort_topology_mutations_enabled, true
config :vesper, :registration_mode, :open

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

# Disable rate limiting in test — SDK integration tests register many users rapidly
config :vesper, disable_rate_limiting: true
