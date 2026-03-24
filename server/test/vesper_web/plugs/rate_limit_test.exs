defmodule VesperWeb.Plugs.RateLimitTest do
  use ExUnit.Case, async: false

  alias VesperWeb.Plugs.RateLimit

  defp build_conn(ip, params \\ %{}) do
    :post
    |> Plug.Test.conn("/api/v1/auth/login")
    |> Map.put(:remote_ip, ip)
    |> Map.put(:params, params)
    |> Plug.Conn.put_private(:phoenix_endpoint, VesperWeb.Endpoint)
  end

  describe "login rate limiting" do
    test "allows up to 5 requests" do
      ip = {10, 0, 1, 1}
      opts = RateLimit.init(action: :login)

      results =
        for _ <- 1..5 do
          conn = build_conn(ip) |> RateLimit.call(opts)
          conn.halted
        end

      assert results == [false, false, false, false, false]
    end

    test "blocks the 6th request with 429" do
      ip = {10, 0, 1, 2}
      opts = RateLimit.init(action: :login)

      for _ <- 1..5 do
        build_conn(ip) |> RateLimit.call(opts)
      end

      conn = build_conn(ip) |> RateLimit.call(opts)

      assert conn.halted
      assert conn.status == 429
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["60"]

      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "rate limit exceeded"
      assert body["retry_after"] == 60
    end
  end

  describe "register rate limiting" do
    test "allows up to 3 requests" do
      ip = {10, 0, 2, 1}
      opts = RateLimit.init(action: :register)

      results =
        for _ <- 1..3 do
          conn = build_conn(ip) |> RateLimit.call(opts)
          conn.halted
        end

      assert results == [false, false, false]
    end

    test "blocks the 4th request with 429" do
      ip = {10, 0, 2, 2}
      opts = RateLimit.init(action: :register)

      for _ <- 1..3 do
        build_conn(ip) |> RateLimit.call(opts)
      end

      conn = build_conn(ip) |> RateLimit.call(opts)

      assert conn.halted
      assert conn.status == 429
    end
  end

  describe "recover rate limiting" do
    test "allows up to 3 requests within 600s window" do
      ip = {10, 0, 3, 1}
      opts = RateLimit.init(action: :recover)

      results =
        for _ <- 1..3 do
          conn = build_conn(ip) |> RateLimit.call(opts)
          conn.halted
        end

      assert results == [false, false, false]
    end

    test "blocks the 4th request with 429 and retry-after of 600" do
      ip = {10, 0, 3, 2}
      opts = RateLimit.init(action: :recover)

      for _ <- 1..3 do
        build_conn(ip) |> RateLimit.call(opts)
      end

      conn = build_conn(ip) |> RateLimit.call(opts)

      assert conn.halted
      assert conn.status == 429
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["600"]

      body = Jason.decode!(conn.resp_body)
      assert body["retry_after"] == 600
    end
  end

  describe "init/1" do
    test "returns correct config for known actions" do
      assert %{action: :login, limit: 5, window: 60_000} = RateLimit.init(action: :login)
      assert %{action: :register, limit: 3, window: 60_000} = RateLimit.init(action: :register)
      assert %{action: :recover, limit: 3, window: 600_000} = RateLimit.init(action: :recover)
    end

    test "falls back to default limits for unknown actions" do
      assert %{action: :unknown, limit: 60, window: 60_000} = RateLimit.init(action: :unknown)
    end
  end
end
