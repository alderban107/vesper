defmodule VesperWeb.Plugs.RateLimit do
  @moduledoc """
  Rate limiting plug using Hammer.

  Configurable limits per action type. Uses client IP as the default key,
  with optional per-username limiting for login attempts.
  """

  import Plug.Conn
  require Logger

  @default_limits %{
    login: {20, 60_000},
    register: {10, 60_000},
    recover: {5, 600_000},
    refresh: {60, 60_000},
    upload: {20, 3_600_000},
    default: {120, 60_000}
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

  defp rate_limit_key(conn, :upload) do
    case conn.assigns[:current_user] do
      %{id: user_id} when is_binary(user_id) -> "upload:user:#{user_id}"
      _ -> "upload:ip:#{client_ip(conn)}"
    end
  end

  defp rate_limit_key(conn, action) do
    "#{action}:#{client_ip(conn)}"
  end

  defp client_ip(conn) do
    remote_ip = conn.remote_ip |> :inet.ntoa() |> to_string()

    if Application.get_env(:vesper, :trust_proxy_headers, false) do
      trusted_forwarded_ip(conn) || remote_ip
    else
      remote_ip
    end
  end

  # A trusted edge must overwrite X-Forwarded-For with exactly one address.
  # Reject chains rather than guessing which hop is authoritative; the bundled
  # nginx proxy follows this contract. Direct deployments default to ignoring
  # forwarding headers entirely.
  defp trusted_forwarded_ip(conn) do
    case get_req_header(conn, "x-forwarded-for") do
      [header] ->
        value = String.trim(header)

        if String.contains?(value, ",") do
          nil
        else
          case :inet.parse_address(String.to_charlist(value)) do
            {:ok, address} -> address |> :inet.ntoa() |> to_string()
            {:error, _reason} -> nil
          end
        end

      _ ->
        nil
    end
  end
end
