defmodule VesperWeb.OriginPolicyTest do
  use ExUnit.Case, async: true

  alias VesperWeb.OriginPolicy

  test "normalizes explicit network and packaged-renderer origins" do
    assert OriginPolicy.parse_config!(
             "HTTPS://App.Example.com:443, http://localhost:8080, null, file://"
           ) == [
             "https://app.example.com",
             "http://localhost:8080",
             "null",
             "file://"
           ]
  end

  test "rejects wildcard, credentialed, and path-bearing origins" do
    for invalid <- [
          "*",
          "https://*.example.com",
          "https://user:secret@example.com",
          "https://example.com/path",
          "javascript:alert(1)",
          ""
        ] do
      assert_raise ArgumentError, fn -> OriginPolicy.parse_config!(invalid) end
    end
  end

  test "CORS plug accepts the exact opaque packaged-renderer origins" do
    allowed = OriginPolicy.parse_config!("https://app.example.com,null,file://")

    for origin <- ["null", "file://"] do
      conn =
        Plug.Test.conn(:get, "/api/v1/users/me")
        |> Plug.Conn.put_req_header("origin", origin)
        |> CORSPlug.call(CORSPlug.init(origin: allowed))

      assert Plug.Conn.get_resp_header(conn, "access-control-allow-origin") == [origin]
    end
  end

  test "Phoenix origin MFA accepts only exact configured origins" do
    allowed = OriginPolicy.parse_config!("https://app.example.com,null,file://")

    assert OriginPolicy.allowed?(URI.parse("https://app.example.com"), allowed)
    refute OriginPolicy.allowed?(URI.parse("https://sub.app.example.com"), allowed)
    assert OriginPolicy.allowed?(URI.parse("null"), allowed)
    assert OriginPolicy.allowed?(URI.parse("file://"), allowed)
    refute OriginPolicy.allowed?(URI.parse("data:text/plain,hello"), allowed)
  end
end
