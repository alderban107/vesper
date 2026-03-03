# Stage 1: Build the Elixir release
FROM elixir:1.18-otp-27-slim AS build

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
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libstdc++6 openssl libncurses6 locales ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Set locale
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8

WORKDIR /app

# Create uploads directory (including avatars subdirectory)
RUN mkdir -p /app/priv/uploads/avatars

# Copy the release from build stage
COPY --from=build /app/_build/prod/rel/vesper ./

ENV PHX_SERVER=true

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=60s \
  CMD curl -sf http://localhost:4000/health || exit 1

CMD ["bin/vesper", "start"]
