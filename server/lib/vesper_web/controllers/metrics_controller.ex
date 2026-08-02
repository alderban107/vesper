defmodule VesperWeb.MetricsController do
  use VesperWeb, :controller

  def show(conn, _params) do
    configured_token = Application.get_env(:vesper, :metrics_token)
    presented_token = bearer_token(conn)

    if valid_token?(configured_token, presented_token) do
      body = TelemetryMetricsPrometheus.Core.scrape()

      conn
      |> put_resp_content_type("text/plain; version=0.0.4")
      |> send_resp(:ok, body)
    else
      conn
      |> put_resp_header("www-authenticate", ~s(Bearer realm="vesper-metrics"))
      |> send_resp(:unauthorized, "unauthorized\n")
    end
  end

  defp bearer_token(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] -> token
      _ -> nil
    end
  end

  defp valid_token?(expected, presented)
       when is_binary(expected) and is_binary(presented) and
              byte_size(expected) == byte_size(presented) do
    byte_size(expected) >= 32 and Plug.Crypto.secure_compare(expected, presented)
  end

  defp valid_token?(_expected, _presented), do: false
end
