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

  test "attachment range headers are available to the web client", %{conn: conn} do
    Application.put_env(:vesper, :cors_origins, ["https://app.example.com"])

    response =
      conn
      |> put_req_header("origin", "https://app.example.com")
      |> put_req_header("access-control-request-method", "GET")
      |> put_req_header(
        "access-control-request-headers",
        "authorization, range, if-range, x-vesper-filename-b64, x-vesper-content-type"
      )
      |> options("/api/v1/attachments/example")

    assert response.status == 204
    assert "get" in exposed_values(response, "access-control-allow-methods")
    assert "head" in exposed_values(response, "access-control-allow-methods")
    assert "authorization" in exposed_values(response, "access-control-allow-headers")
    assert "range" in exposed_values(response, "access-control-allow-headers")
    assert "if-range" in exposed_values(response, "access-control-allow-headers")
    assert "x-vesper-filename-b64" in exposed_values(response, "access-control-allow-headers")
    assert "x-vesper-content-type" in exposed_values(response, "access-control-allow-headers")

    assert exposed_values(response, "access-control-expose-headers") ==
             ~w(accept-ranges content-range etag content-disposition)
  end

  defp exposed_values(conn, header) do
    conn
    |> get_resp_header(header)
    |> Enum.flat_map(&String.split(&1, ","))
    |> Enum.map(&(&1 |> String.trim() |> String.downcase()))
  end
end
