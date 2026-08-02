defmodule VesperWeb.OriginPolicy do
  @moduledoc false

  @opaque_origins ["null", "file://"]
  @network_schemes ["http", "https"]

  # CORSPlug invokes this zero-arity callback for every request, after
  # config/runtime.exs has populated the production allowlist.
  def cors_origins do
    Application.get_env(:vesper, :cors_origins, [])
  end

  def parse_config!(raw_origins) when is_binary(raw_origins) do
    origins =
      raw_origins
      |> String.split(",")
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.map(&normalize_configured_origin!/1)
      |> Enum.uniq()

    if origins == [] do
      raise ArgumentError, "CORS_ORIGIN must contain one or more explicit origins"
    end

    origins
  end

  def allowed?(%URI{} = uri, allowed_origins) when is_list(allowed_origins) do
    case normalize_request_origin(uri) do
      nil -> false
      origin -> origin in allowed_origins
    end
  end

  defp normalize_configured_origin!(origin) when origin in @opaque_origins, do: origin

  defp normalize_configured_origin!(origin) do
    if String.contains?(origin, "*") do
      raise ArgumentError, "CORS_ORIGIN wildcards are forbidden: #{inspect(origin)}"
    end

    uri = URI.parse(origin)

    if uri.scheme not in @network_schemes or is_nil(uri.host) or uri.host == "" or
         not is_nil(uri.userinfo) or uri.path not in [nil, ""] or not is_nil(uri.query) or
         not is_nil(uri.fragment) do
      raise ArgumentError,
            "CORS_ORIGIN entries must be explicit HTTP(S) origins, `null`, or `file://`: #{inspect(origin)}"
    end

    canonical_network_origin(uri)
  end

  defp normalize_request_origin(%URI{scheme: nil, host: nil, path: "null"}), do: "null"

  defp normalize_request_origin(%URI{scheme: "file", host: host}) when host in [nil, ""],
    do: "file://"

  defp normalize_request_origin(%URI{scheme: scheme, host: host} = uri)
       when scheme in @network_schemes and is_binary(host) do
    canonical_network_origin(uri)
  end

  defp normalize_request_origin(_uri), do: nil

  defp canonical_network_origin(%URI{} = uri) do
    port =
      case {uri.scheme, uri.port} do
        {"http", 80} -> nil
        {"https", 443} -> nil
        {_scheme, port} -> port
      end

    %URI{scheme: String.downcase(uri.scheme), host: String.downcase(uri.host), port: port}
    |> URI.to_string()
  end
end
