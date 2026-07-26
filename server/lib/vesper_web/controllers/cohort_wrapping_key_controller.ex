defmodule VesperWeb.CohortWrappingKeyController do
  use VesperWeb, :controller

  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  def show(conn, %{"group_id" => group_id}) do
    with {:ok, _authorization} <-
           ControllerHelpers.authorize_mls_public_read(conn.assigns.current_user.id, group_id) do
      case Encryption.get_cohort_wrapping_key(group_id) do
        nil -> conn |> put_status(:not_found) |> json(%{error: "no wrapping key"})
        key -> json(conn, %{wrapping_key: render_key(key)})
      end
    else
      {:error, reason} -> authorization_error(conn, reason)
    end
  end

  def upsert(conn, %{"group_id" => group_id} = params) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    with true <- conn.assigns[:current_device_trusted?] == true,
         {:ok, authorization} <- ControllerHelpers.authorize_mls_scope(user.id, group_id),
         {:ok, attrs} <- decode_attrs(params),
         {:ok, key} <-
           Encryption.upsert_cohort_wrapping_key(
             Map.merge(attrs, %{
               group_id: group_id,
               room_id: authorization.room_id,
               cohort_id: authorization.cohort_id,
               topology_generation: authorization.topology_generation,
               publisher_id: user.id,
               publisher_device_id: device.client_id
             })
           ) do
      json(conn, %{wrapping_key: render_key(key)})
    else
      false ->
        conn |> put_status(:forbidden) |> json(%{error: "trusted device required"})

      {:error, :epoch_conflict} ->
        conn |> put_status(:conflict) |> json(%{error: "epoch_conflict"})

      {:error, :invalid_publication} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid publication"})

      {:error, reason} when reason in [:invalid_scope, :forbidden, :not_found] ->
        authorization_error(conn, reason)

      {:error, changeset} ->
        conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(changeset.errors)})
    end
  end

  defp decode_attrs(params) do
    with {:ok, public_key} <- decode(params["public_key"], 32),
         {:ok, signature} <- decode(params["signature"], 64),
         {:ok, signer_public_key} <- decode(params["signer_public_key"], 32),
         {:ok, group_info_digest} <- decode(params["group_info_digest"], 32),
         signer_identity when is_binary(signer_identity) and byte_size(signer_identity) > 0 <-
           params["signer_identity"],
         epoch when is_integer(epoch) and epoch >= 0 <- params["mls_epoch"] do
      {:ok,
       %{
         public_key: public_key,
         signature: signature,
         signer_public_key: signer_public_key,
         group_info_digest: group_info_digest,
         signer_identity: signer_identity,
         mls_epoch: epoch
       }}
    else
      _ -> {:error, :invalid_publication}
    end
  end

  defp decode(value, size) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} when byte_size(decoded) == size -> {:ok, decoded}
      _ -> {:error, :invalid_publication}
    end
  end

  defp decode(_, _), do: {:error, :invalid_publication}

  defp render_key(key) do
    %{
      group_id: key.group_id,
      topology_generation: key.topology_generation,
      mls_epoch: key.mls_epoch,
      public_key: Base.encode64(key.public_key),
      signature: Base.encode64(key.signature),
      signer_identity: key.signer_identity,
      signer_public_key: Base.encode64(key.signer_public_key),
      group_info_digest: Base.encode64(key.group_info_digest),
      publisher_id: key.publisher_id,
      publisher_device_id: key.publisher_device_id,
      updated_at: key.updated_at
    }
  end

  defp authorization_error(conn, :invalid_scope),
    do: conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

  defp authorization_error(conn, :forbidden),
    do: conn |> put_status(:forbidden) |> json(%{error: "not a member"})

  defp authorization_error(conn, :not_found),
    do: conn |> put_status(:not_found) |> json(%{error: "scope not found"})
end
