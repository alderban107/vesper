defmodule VesperWeb.RequestSizeTest do
  use Vesper.ConnCase, async: true

  test "public auth JSON cannot consume the multipart upload allowance", %{conn: conn} do
    body =
      Jason.encode!(%{
        username: String.duplicate("a", 1_048_576),
        password: "irrelevant"
      })

    assert_raise Plug.Parsers.RequestTooLargeError, fn ->
      conn
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/auth/login", body)
    end
  end
end
