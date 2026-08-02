defmodule VesperWeb.MetricsControllerTest do
  use Vesper.ConnCase, async: false

  @token String.duplicate("test-metrics-token-", 2)

  test "metrics require the dedicated bearer token", %{conn: conn} do
    assert conn |> get("/metrics") |> response(401) == "unauthorized\n"

    assert conn
           |> put_req_header("authorization", "Bearer wrong-token")
           |> get("/metrics")
           |> response(401) == "unauthorized\n"
  end

  test "authorized scrapes use Prometheus exposition format", %{conn: conn} do
    conn =
      conn
      |> put_req_header("authorization", "Bearer #{@token}")
      |> get("/metrics")

    assert response(conn, 200) =~ "vesper_"

    assert get_resp_header(conn, "content-type") == [
             "text/plain; version=0.0.4; charset=utf-8"
           ]
  end
end
