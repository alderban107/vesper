defmodule VesperWeb.ScopeRecoveryPackageControllerTest do
  use Vesper.ConnCase, async: true

  alias Vesper.Encryption
  alias Vesper.Servers
  alias VesperWeb.ScopeRecoveryPackageController

  @max_package_bytes 262_144
  @nonce :binary.copy(<<7>>, 12)

  test "accepts a base64 package whose decoded ciphertext reaches the byte limit", %{conn: conn} do
    {owner, channel} = owner_and_channel!()
    ciphertext_bytes = :binary.copy(<<11>>, @max_package_bytes - byte_size(@nonce))
    ciphertext = Base.encode64(ciphertext_bytes)

    conn =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> ScopeRecoveryPackageController.upsert(package_params(channel.id, ciphertext))

    assert %{"package" => %{"byte_size" => @max_package_bytes, "ciphertext" => ^ciphertext}} =
             json_response(conn, 200)

    stored = Encryption.get_scope_recovery_package(owner.id, channel.id)
    assert stored.byte_size == @max_package_bytes
    assert stored.ciphertext == ciphertext
  end

  test "rejects only decoded package bytes above the limit with HTTP 413", %{conn: conn} do
    {owner, channel} = owner_and_channel!()

    ciphertext =
      :binary.copy(<<13>>, @max_package_bytes - byte_size(@nonce) + 1)
      |> Base.encode64()

    conn =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> ScopeRecoveryPackageController.upsert(package_params(channel.id, ciphertext))

    assert json_response(conn, 413) == %{"error" => "recovery package too large"}
    assert Encryption.get_scope_recovery_package(owner.id, channel.id) == nil
  end

  test "rejects malformed base64 as an invalid package", %{conn: conn} do
    {owner, channel} = owner_and_channel!()

    conn =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> ScopeRecoveryPackageController.upsert(package_params(channel.id, "not-base64"))

    assert json_response(conn, 400) == %{"error" => "invalid recovery package"}
  end

  defp owner_and_channel! do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Recovery Package Test"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    {owner, channel}
  end

  defp package_params(scope_id, ciphertext) do
    %{
      "scope_id" => scope_id,
      "ciphertext" => ciphertext,
      "nonce" => Base.encode64(@nonce),
      "membership_generation" => 1,
      "last_event_seq" => 1,
      "schema_version" => 1
    }
  end
end
