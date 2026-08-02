defmodule VesperWeb.CorsRuntimeTest do
  use Vesper.ConnCase, async: false

  setup do
    previous = Application.get_env(:vesper, :cors_origins)

    on_exit(fn ->
      if is_nil(previous) do
        Application.delete_env(:vesper, :cors_origins)
      else
        Application.put_env(:vesper, :cors_origins, previous)
      end
    end)

    :ok
  end

  test "the compiled endpoint resolves the runtime allowlist per request", %{conn: conn} do
    Application.put_env(:vesper, :cors_origins, ["https://app.example.com"])

    allowed =
      conn
      |> put_req_header("origin", "https://app.example.com")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/auth/login")

    assert allowed.status == 204

    assert get_resp_header(allowed, "access-control-allow-origin") == [
             "https://app.example.com"
           ]

    denied =
      build_conn()
      |> put_req_header("origin", "https://evil.example")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/auth/login")

    assert denied.status == 204
    assert get_resp_header(denied, "access-control-allow-origin") == []
  end
end
