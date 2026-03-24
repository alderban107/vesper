defmodule VesperWeb.Plugs.RateLimit do
  @moduledoc """
  Rate limiting plug using Hammer.

  Configurable limits per action type. Uses client IP as the default key,
  with optional per-username limiting for login attempts.
  """

  import Plug.Conn
  require Logger

  @default_limits %{
    login: {5, 60_000},
    register: {3, 60_000},
    recover: {3, 600_000},
    refresh: {30, 60_000},
    default: {60, 60_000}
  }

  def init(opts) do
    action = Keyword.fetch!(opts, :action)
    {limit, window} = Map.get(@default_limits, action, @default_limits.default)
    %{action: action, limit: limit, window: window}
  end

  def call(conn, %{action: action, limit: limit, window: window}) do
    if Application.get_env(:vesper, :disable_rate_limiting, false) do
      conn
    else
      do_rate_limit(conn, action, limit, window)
    end
  end

  defp do_rate_limit(conn, action, limit, window) do
    key = rate_limit_key(conn, action)

    case Hammer.check_rate(key, window, limit) do
      {:allow, _count} ->
        conn

      {:deny, _limit} ->
        retry_after = div(window, 1000)

        Logger.warning("Rate limit exceeded",
          action: action,
          ip: client_ip(conn),
          key: key
        )

        conn
        |> put_resp_header("retry-after", Integer.to_string(retry_after))
        |> put_status(:too_many_requests)
        |> Phoenix.Controller.json(%{
          error: "rate limit exceeded",
          retry_after: retry_after
        })
        |> halt()
    end
  end

  defp rate_limit_key(conn, :login) do
    ip = client_ip(conn)
    username = get_in(conn.params, ["username"]) || "unknown"
    "login:#{ip}:#{username}"
  end

  defp rate_limit_key(conn, action) do
    "#{action}:#{client_ip(conn)}"
  end

  defp client_ip(conn) do
    forwarded_for =
      conn
      |> get_req_header("x-forwarded-for")
      |> List.first()

    case forwarded_for do
      nil ->
        conn.remote_ip |> :inet.ntoa() |> to_string()

      header ->
        header
        |> String.split(",")
        |> List.first()
        |> String.trim()
    end
  end
end
