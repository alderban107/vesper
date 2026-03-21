defmodule VesperWeb.KeyPackageController do
  use VesperWeb, :controller
  alias Vesper.Encryption

  @doc "POST /api/v1/key-packages — bulk upload key packages"
  def create(conn, %{"key_packages" => packages}) when is_list(packages) do
    user_id = conn.assigns.current_user.id
    current_device = conn.assigns.current_device

    result =
      Enum.reduce_while(packages, {:ok, []}, fn b64, {:ok, acc} ->
        case Base.decode64(b64) do
          {:ok, decoded} -> {:cont, {:ok, [decoded | acc]}}
          :error -> {:halt, :error}
        end
      end)

    case result do
      {:ok, decoded} ->
        {count, _} =
          Encryption.upload_key_packages(user_id, current_device.client_id, Enum.reverse(decoded))

        conn
        |> put_status(:created)
        |> json(%{uploaded: count})

      :error ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "invalid base64 in key_packages"})
    end
  end

  def create(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "key_packages array is required"})
  end

  @doc "GET /api/v1/key-packages/:user_id — fetch one unconsumed key package"
  def show(conn, %{"user_id" => user_id} = params) do
    case Encryption.fetch_and_consume_key_package(user_id, params["device_id"]) do
      nil ->
        conn
        |> put_status(:not_found)
        |> json(%{error: "no key packages available"})

      data ->
        json(conn, %{key_package: Base.encode64(data)})
    end
  end

  @doc "GET /api/v1/key-packages/me/count — count unconsumed for current user"
  def count(conn, _params) do
    count =
      Encryption.count_key_packages(
        conn.assigns.current_user.id,
        conn.assigns.current_device.client_id
      )

    json(conn, %{count: count})
  end

  @doc "DELETE /api/v1/key-packages/me — purge all unconsumed key packages for current user"
  def purge(conn, _params) do
    {count, _} =
      Encryption.purge_key_packages(
        conn.assigns.current_user.id,
        conn.assigns.current_device.client_id
      )

    json(conn, %{purged: count})
  end

  @doc "POST /api/v1/key-packages/me/consume — mark a specific own key package as consumed"
  def consume(conn, %{"key_package" => b64}) when is_binary(b64) do
    case Base.decode64(b64) do
      {:ok, decoded} ->
        case Encryption.consume_own_key_package(
               conn.assigns.current_user.id,
               conn.assigns.current_device.client_id,
               decoded
             ) do
          :ok ->
            json(conn, %{consumed: true})

          {:error, :not_found} ->
            conn
            |> put_status(:not_found)
            |> json(%{error: "key package not found or already consumed"})
        end

      :error ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "invalid base64"})
    end
  end

  def consume(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "key_package is required"})
  end
end
