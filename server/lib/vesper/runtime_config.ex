defmodule Vesper.RuntimeConfig do
  @moduledoc false

  def normalize_dns_cluster_query(nil), do: nil

  def normalize_dns_cluster_query(query) when is_binary(query) do
    query = String.trim(query)

    cond do
      query == "" -> nil
      String.ends_with?(query, ".") -> query
      true -> query <> "."
    end
  end

  def secret_or_fallback!(name, configured, fallback, min_bytes)
      when is_binary(name) and is_integer(min_bytes) and min_bytes > 0 do
    candidate =
      case configured do
        value when is_binary(value) ->
          if String.trim(value) == "", do: fallback, else: value

        nil ->
          fallback
      end

    if not is_binary(candidate) or byte_size(candidate) < min_bytes do
      raise "#{name} must contain at least #{min_bytes} bytes"
    end

    candidate
  end
end
