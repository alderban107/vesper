defmodule VesperWeb.MlsEventController do
  use VesperWeb, :controller

  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  @default_limit 200
  @max_limit 500

  @doc "GET /api/v1/mls-events/:channel_id — fetch durable MLS control events after a local cursor"
  def index(conn, %{"channel_id" => scope_id} = params) do
    user = conn.assigns.current_user

    case ControllerHelpers.authorize_mls_scope(user.id, scope_id) do
      {:ok, %{group_id: authorized_group_id}} ->
        after_seq = parse_non_negative_integer(Map.get(params, "after_seq"), 0)
        limit = parse_non_negative_integer(Map.get(params, "limit"), @default_limit)

        render_events(
          conn,
          Encryption.list_mls_events_after(
            authorized_group_id,
            after_seq,
            min(max(limit, 1), @max_limit)
          )
        )

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  defp render_events(conn, events) do
    json(conn, %{
      events:
        Enum.map(events, fn event ->
          %{
            seq: event.id,
            event_type: event.event_type,
            payload: event.payload,
            sender_id: event.sender_id,
            sender_device_id: event.sender_device_id,
            inserted_at: event.inserted_at
          }
        end)
    })
  end

  defp parse_non_negative_integer(nil, default), do: default

  defp parse_non_negative_integer(value, default) when is_integer(value) do
    if value >= 0, do: value, else: default
  end

  defp parse_non_negative_integer(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed >= 0 -> parsed
      _ -> default
    end
  end

  defp parse_non_negative_integer(_, default), do: default
end
