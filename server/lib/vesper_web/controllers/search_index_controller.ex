defmodule VesperWeb.SearchIndexController do
  use VesperWeb, :controller

  alias Vesper.Accounts

  @max_ciphertext_bytes 2_000_000

  def show(conn, _params) do
    user = conn.assigns.current_user

    case Accounts.get_search_index_snapshot(user.id) do
      nil ->
        json(conn, %{snapshot: nil})

      snapshot ->
        json(conn, %{snapshot: snapshot_json(snapshot)})
    end
  end

  def upsert(conn, params) do
    user = conn.assigns.current_user

    with {:ok, ciphertext} <- decode_b64(params["ciphertext"], "ciphertext"),
         {:ok, nonce} <- decode_b64(params["nonce"], "nonce"),
         :ok <- validate_sizes(ciphertext, nonce),
         attrs <- %{
           "device_id" => params["device_id"],
           "expected_version" => params["expected_version"],
           "ciphertext" => ciphertext,
           "nonce" => nonce
         } do
      case Accounts.upsert_search_index_snapshot(user.id, attrs) do
        {:ok, snapshot} ->
          json(conn, %{snapshot: snapshot_json(snapshot)})

        {:error, :conflict, snapshot} ->
          conn
          |> put_status(:conflict)
          |> json(%{error: "version_conflict", snapshot: snapshot_json(snapshot)})

        {:error, changeset} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{error: inspect(changeset.errors)})
      end
    else
      {:error, reason} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: reason})
    end
  end

  def delete(conn, _params) do
    user = conn.assigns.current_user
    :ok = Accounts.delete_search_index_snapshot(user.id)
    json(conn, %{ok: true})
  end

  defp snapshot_json(snapshot) do
    %{
      version: snapshot.version,
      device_id: snapshot.device_id,
      ciphertext: Base.encode64(snapshot.ciphertext),
      nonce: Base.encode64(snapshot.nonce),
      updated_at: snapshot.updated_at
    }
  end

  defp decode_b64(nil, field), do: {:error, "#{field} is required"}

  defp decode_b64(value, field) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} -> {:ok, decoded}
      :error -> {:error, "#{field} must be base64"}
    end
  end

  defp decode_b64(_value, field), do: {:error, "#{field} must be a string"}

  defp validate_sizes(ciphertext, nonce) do
    cond do
      byte_size(ciphertext) == 0 ->
        {:error, "ciphertext is required"}

      byte_size(ciphertext) > @max_ciphertext_bytes ->
        {:error, "ciphertext too large"}

      byte_size(nonce) != 12 ->
        {:error, "nonce must be 12 bytes"}

      true ->
        :ok
    end
  end
end
