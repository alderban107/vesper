# Stage 1: Build the Elixir release
FROM elixir:1.18-otp-27-slim@sha256:09ab42c7332fbe1a77cd0207ac4503e26ad064a24396c1809bdbc97377731387 AS build

RUN apt-get update && apt-get install -y git build-essential pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV MIX_ENV=prod

# Install hex + rebar
RUN mix local.hex --force && mix local.rebar --force

# Install dependencies
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod
RUN mix deps.compile

# Copy application code
COPY config config
COPY lib lib
COPY priv priv

# Compile and build release
RUN mix compile
RUN mix release

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libstdc++6 openssl libncurses6 locales ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Set locale
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8

WORKDIR /app

# Create uploads directory at a stable path for Docker volume mounts.
# FileStorage writes here in production (configured in runtime.exs).
# The release's Application.app_dir would resolve to a versioned path
# (e.g. /app/lib/vesper-0.1.0/priv/uploads) which is wiped on image updates.
RUN groupadd --system vesper && \
    useradd --system --gid vesper --home-dir /app --shell /usr/sbin/nologin vesper && \
    mkdir -p /var/lib/vesper/uploads/avatars /var/lib/vesper/uploads/banners && \
    chown -R vesper:vesper /var/lib/vesper

# Keep release code root-owned and read-only to the runtime user.
COPY --from=build /app/_build/prod/rel/vesper ./

ENV PHX_SERVER=true

USER vesper

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=60s \
  CMD curl -sf http://localhost:4000/health || exit 1

CMD ["bin/vesper", "start"]
