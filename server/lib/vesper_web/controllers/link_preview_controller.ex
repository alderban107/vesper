defmodule VesperWeb.LinkPreviewController do
  use VesperWeb, :controller

  alias Vesper.Chat.LinkPreviewFetcher

  def create(conn, %{"url" => url}) do
    case LinkPreviewFetcher.fetch_preview(url) do
      {:ok, preview} ->
        json(conn, %{
          preview: %{
            url: preview.url,
            title: preview.title,
            description: preview.description,
            image_url: preview.image_url,
            site_name: preview.site_name
          }
        })

      {:error, :blocked} ->
        conn |> put_status(:bad_request) |> json(%{error: "URL not allowed"})

      {:error, _} ->
        conn |> put_status(:unprocessable_entity) |> json(%{error: "could not fetch preview"})
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "url is required"})
  end
end
