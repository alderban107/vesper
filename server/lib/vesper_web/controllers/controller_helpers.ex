defmodule VesperWeb.ControllerHelpers do
  @moduledoc """
  Shared utility functions for controllers.
  """

  @doc """
  Parses a string or integer value as an integer, returning `default` on failure.
  """
  def parse_int(nil, default), do: default

  def parse_int(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {n, _} -> n
      :error -> default
    end
  end

  def parse_int(value, _default) when is_integer(value), do: value
  def parse_int(_, default), do: default

  @doc """
  Parses a string, integer, or boolean value as a boolean, returning `default`
  on failure.
  """
  def parse_bool(nil, default), do: default
  def parse_bool(value, _default) when is_boolean(value), do: value
  def parse_bool(value, _default) when is_integer(value), do: value != 0

  def parse_bool(value, default) when is_binary(value) do
    case String.downcase(String.trim(value)) do
      value when value in ["1", "true", "yes", "on"] -> true
      value when value in ["0", "false", "no", "off"] -> false
      _ -> default
    end
  end

  def parse_bool(_, default), do: default

  @doc """
  Formats Ecto changeset errors into a plain map of field => message strings,
  suitable for returning in JSON API responses.
  """
  def format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
