import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/vesper start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :vesper, VesperWeb.Endpoint, server: true
end

config :vesper, VesperWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  maybe_ipv6 = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :vesper, Vesper.Repo,
    # ssl: true,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # For machines with several cores, consider starting multiple pools of `pool_size`
    # pool_count: 4,
    socket_options: maybe_ipv6

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :vesper, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  port = String.to_integer(System.get_env("PORT") || "4000")

  # Trust WebSocket connections from the web client origin (defaults to same-host only)
  check_origin =
    case System.get_env("CORS_ORIGIN") do
      nil -> true
      "*" -> false
      origins -> String.split(origins, ",") |> Enum.map(&String.trim/1)
    end

  config :vesper, VesperWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base,
    check_origin: check_origin

  # JWT signing key — defaults to secret_key_base if not set
  jwt_secret = System.get_env("JWT_SECRET") || secret_key_base

  config :joken,
    default_signer: [
      signer_alg: "HS256",
      key_octet: jwt_secret
    ]

  # ICE/TURN servers for WebRTC voice.
  # For proxied web deployments, prefer:
  # TURN_SERVER_URL=turns:your-turn-host:443?transport=tcp
  # VOICE_ICE_TRANSPORT_POLICY=relay
  ice_servers =
    case System.get_env("TURN_SERVER_URL") do
      nil ->
        [%{urls: "stun:stun.l.google.com:19302"}]

      turn_url ->
        turn_user = System.get_env("TURN_USERNAME") || "vesper"

        turn_pass =
          System.get_env("TURN_PASSWORD") ||
            raise("TURN_PASSWORD required when TURN_SERVER_URL is set")

        [
          %{urls: "stun:stun.l.google.com:19302"},
          %{urls: turn_url, username: turn_user, credential: turn_pass}
        ]
    end

  ice_transport_policy =
    case System.get_env("VOICE_ICE_TRANSPORT_POLICY") do
      nil ->
        if System.get_env("TURN_SERVER_URL"), do: "relay", else: "all"

      policy when policy in ["all", "relay"] ->
        policy

      other ->
        raise("VOICE_ICE_TRANSPORT_POLICY must be 'all' or 'relay', got: #{inspect(other)}")
    end

  config :vesper, :ice_servers, ice_servers
  config :vesper, :ice_transport_policy, ice_transport_policy

  # Max upload size (default 25MB)
  config :vesper,
         :max_upload_size,
         String.to_integer(System.get_env("MAX_UPLOAD_SIZE") || "26214400")

  # File expiry (default 30 days)
  config :vesper, :file_expiry_days, String.to_integer(System.get_env("FILE_EXPIRY_DAYS") || "30")

  # CORS — restrict to the configured origin in production.
  # Set CORS_ORIGIN to your frontend URL (e.g. "https://app.example.com").
  # WARNING: leaving CORS_ORIGIN unset allows all origins ("*"), which is
  # acceptable for self-hosted deployments but SHOULD be set explicitly in
  # any multi-tenant or public-facing production environment.
  cors_origin = System.get_env("CORS_ORIGIN") || "*"

  if cors_origin == "*" do
    require Logger

    Logger.warning(
      "CORS_ORIGIN is not set — allowing all origins (*). " <>
        "Set CORS_ORIGIN to restrict cross-origin access in production."
    )
  end

  config :cors_plug,
    origin: [cors_origin],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    headers: ["authorization", "content-type"]
end
