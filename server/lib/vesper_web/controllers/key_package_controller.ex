defmodule VesperWeb.KeyPackageController do
  use VesperWeb, :controller
  alias Vesper.Encryption

  @doc "POST /api/v1/key-packages — bulk upload key packages"
  def create(conn, %{"key_packages" => packages}) when is_list(packages) do
    user_id = conn.assigns.current_user.id

    decoded =
      Enum.map(packages, fn b64 ->
        Base.decode64!(b64)
      end)

    {count, _} = Encryption.upload_key_packages(user_id, decoded)

    conn
    |> put_status(:created)
    |> json(%{uploaded: count})
  end

  def create(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "key_packages array is required"})
  end

  @doc "GET /api/v1/key-packages/:user_id — fetch one unconsumed key package"
  def show(conn, %{"user_id" => user_id}) do
    case Encryption.fetch_and_consume_key_package(user_id) do
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
    count = Encryption.count_key_packages(conn.assigns.current_user.id)
    json(conn, %{count: count})
  end
end
