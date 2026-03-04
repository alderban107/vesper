defmodule Vesper.Chat.LinkPreviewFetcher do
  @moduledoc """
  Fetches Open Graph metadata from URLs for link previews.
  Includes SSRF protection and caching.
  """

  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Chat.LinkPreview

  # 24 hours
  @cache_ttl_seconds 86_400
  # 5 seconds
  @request_timeout 5_000
  # 512KB
  @max_body_size 524_288

  # Private/reserved IPv4 ranges for SSRF protection
  @blocked_ranges [
    # 10.0.0.0/8
    {10, 0, 0, 0, 8},
    # 172.16.0.0/12
    {172, 16, 0, 0, 12},
    # 192.168.0.0/16
    {192, 168, 0, 0, 16},
    # 127.0.0.0/8
    {127, 0, 0, 0, 8},
    # 169.254.0.0/16
    {169, 254, 0, 0, 16},
    # 0.0.0.0/8
    {0, 0, 0, 0, 8}
  ]

  @max_redirects 3

  def fetch_preview(url) do
    url_hash = :crypto.hash(:sha256, url) |> Base.encode16(case: :lower)
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Check cache
    case get_cached(url_hash, now) do
      %LinkPreview{} = cached ->
        {:ok, cached}

      nil ->
        if blocked_url?(url) do
          {:error, :blocked}
        else
          case do_fetch(url) do
            {:ok, meta} ->
              upsert_preview(url_hash, url, meta, now)

            {:error, reason} ->
              {:error, reason}
          end
        end
    end
  end

  defp get_cached(url_hash, now) do
    ttl_ago = DateTime.add(now, -@cache_ttl_seconds, :second)

    from(p in LinkPreview,
      where: p.url_hash == ^url_hash and p.fetched_at > ^ttl_ago
    )
    |> Repo.one()
  end

  defp upsert_preview(url_hash, url, meta, now) do
    attrs = %{
      url_hash: url_hash,
      url: url,
      title: meta[:title],
      description: meta[:description],
      image_url: meta[:image_url],
      site_name: meta[:site_name],
      fetched_at: now
    }

    %LinkPreview{}
    |> LinkPreview.changeset(attrs)
    |> Repo.insert(
      on_conflict: [
        set: [
          title: meta[:title],
          description: meta[:description],
          image_url: meta[:image_url],
          site_name: meta[:site_name],
          fetched_at: now
        ]
      ],
      conflict_target: :url_hash
    )
  end

  defp do_fetch(url), do: do_fetch(url, @max_redirects)

  defp do_fetch(_url, remaining) when remaining < 0, do: {:error, :too_many_redirects}

  defp do_fetch(url, remaining) do
    case Req.get(url,
           connect_options: [timeout: @request_timeout],
           receive_timeout: @request_timeout,
           max_retries: 0,
           redirect: false
         ) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        # Truncate body to max size for parsing
        body_str =
          if is_binary(body),
            do: binary_part(body, 0, min(byte_size(body), @max_body_size)),
            else: ""

        {:ok, parse_og_tags(body_str)}

      {:ok, %{status: status, headers: headers}} when status in 301..308 ->
        case get_location_header(headers) do
          nil ->
            {:error, :bad_redirect}

          location ->
            if blocked_url?(location),
              do: {:error, :blocked},
              else: do_fetch(location, remaining - 1)
        end

      {:ok, _} ->
        {:error, :bad_status}

      {:error, _} ->
        {:error, :fetch_failed}
    end
  end

  defp get_location_header(headers) do
    Enum.find_value(headers, fn
      {"location", value} -> value
      _ -> nil
    end)
  end

  defp parse_og_tags(html) do
    %{
      title: extract_meta(html, "og:title") || extract_title(html),
      description: extract_meta(html, "og:description") || extract_meta_name(html, "description"),
      image_url: extract_meta(html, "og:image"),
      site_name: extract_meta(html, "og:site_name")
    }
  end

  defp extract_meta(html, property) do
    case Regex.run(
           ~r/<meta[^>]+property=["']#{Regex.escape(property)}["'][^>]+content=["']([^"']+)["']/is,
           html
         ) do
      [_, value] ->
        String.trim(value)

      nil ->
        # Try reverse order (content before property)
        case Regex.run(
               ~r/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']#{Regex.escape(property)}["']/is,
               html
             ) do
          [_, value] -> String.trim(value)
          nil -> nil
        end
    end
  end

  defp extract_meta_name(html, name) do
    case Regex.run(
           ~r/<meta[^>]+name=["']#{Regex.escape(name)}["'][^>]+content=["']([^"']+)["']/is,
           html
         ) do
      [_, value] ->
        String.trim(value)

      nil ->
        case Regex.run(
               ~r/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']#{Regex.escape(name)}["']/is,
               html
             ) do
          [_, value] -> String.trim(value)
          nil -> nil
        end
    end
  end

  defp extract_title(html) do
    case Regex.run(~r/<title[^>]*>([^<]+)<\/title>/is, html) do
      [_, title] -> String.trim(title)
      nil -> nil
    end
  end

  defp blocked_url?(url) do
    case URI.parse(url) do
      %URI{host: host} when is_binary(host) ->
        # Strip brackets from IPv6 literals like [::1]
        clean_host = String.trim(host, "[]")
        host_charlist = String.to_charlist(clean_host)

        case :inet.parse_address(host_charlist) do
          {:ok, ip} ->
            ip_blocked?(ip)

          {:error, _} ->
            # Hostname — resolve both IPv4 and IPv6 and check all results
            ipv4_blocked =
              case :inet.getaddr(host_charlist, :inet) do
                {:ok, ip} -> ip_blocked?(ip)
                {:error, _} -> false
              end

            ipv6_blocked =
              case :inet.getaddr(host_charlist, :inet6) do
                {:ok, ip} -> ip_blocked?(ip)
                {:error, _} -> false
              end

            ipv4_blocked or ipv6_blocked
        end

      _ ->
        true
    end
  end

  # IPv4 blocking
  defp ip_blocked?({a, b, c, d}) do
    Enum.any?(@blocked_ranges, fn {ra, rb, rc, rd, bits} ->
      mask = bsl(0xFFFFFFFF, 32 - bits) |> band(0xFFFFFFFF)
      ip_int = bsl(a, 24) + bsl(b, 16) + bsl(c, 8) + d
      range_int = bsl(ra, 24) + bsl(rb, 16) + bsl(rc, 8) + rd
      band(ip_int, mask) == band(range_int, mask)
    end)
  end

  # IPv6: loopback (::1)
  defp ip_blocked?({0, 0, 0, 0, 0, 0, 0, 1}), do: true

  # IPv6: IPv4-mapped (::ffff:x.x.x.x) — stored as {0,0,0,0,0,0xFFFF,high,low}
  defp ip_blocked?({0, 0, 0, 0, 0, 0xFFFF, high, low}) do
    ip_blocked?(
      {Bitwise.bsr(high, 8), Bitwise.band(high, 0xFF), Bitwise.bsr(low, 8),
       Bitwise.band(low, 0xFF)}
    )
  end

  # IPv6: IPv4-compatible (::x.x.x.x) — deprecated but still resolves
  defp ip_blocked?({0, 0, 0, 0, 0, 0, high, low}) when high != 0 or low > 1 do
    ip_blocked?(
      {Bitwise.bsr(high, 8), Bitwise.band(high, 0xFF), Bitwise.bsr(low, 8),
       Bitwise.band(low, 0xFF)}
    )
  end

  # IPv6: link-local (fe80::/10)
  defp ip_blocked?({a, _, _, _, _, _, _, _}) when a >= 0xFE80 and a <= 0xFEBF, do: true

  # IPv6: unique local (fc00::/7)
  defp ip_blocked?({a, _, _, _, _, _, _, _}) when a >= 0xFC00 and a <= 0xFDFF, do: true

  # IPv6: unspecified (::)
  defp ip_blocked?({0, 0, 0, 0, 0, 0, 0, 0}), do: true

  defp ip_blocked?(_), do: false

  defp band(a, b), do: Bitwise.band(a, b)
  defp bsl(a, b), do: Bitwise.bsl(a, b)
end
