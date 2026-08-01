defmodule VesperWeb.RoomCryptoTopologyControllerTest do
  use Vesper.ConnCase, async: false

  alias Vesper.Encryption
  alias Vesper.Runtime
  alias Vesper.Servers
  alias VesperWeb.RoomCryptoTopologyController

  test "returns only the current member's topology resolution", %{conn: conn} do
    owner = insert_user()
    member = insert_user()
    outsider = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Topology API"})
    {:ok, _membership} = Servers.join_server(member, server.invite_code)
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _single} = Encryption.ensure_room_topology(room.id)
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 2)
    assert {:ok, _active} = Encryption.activate_room_topology(preparing.id, room.current_seq)

    owner_conn =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> RoomCryptoTopologyController.show(%{"scope_id" => channel.id})

    assert %{
             "topology" =>
               %{
                 "mode" => "multi_cohort",
                 "generation" => 2,
                 "cohort_id" => owner_cohort_id,
                 "group_id" => owner_group_id
               } = owner_topology
           } = json_response(owner_conn, 200)

    refute Map.has_key?(owner_topology, "cohorts")
    assert is_binary(owner_cohort_id)
    assert is_binary(owner_group_id)

    member_conn =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.assign(:current_user, member)
      |> RoomCryptoTopologyController.show(%{"scope_id" => channel.id})

    assert %{"topology" => %{"cohort_id" => member_cohort_id}} = json_response(member_conn, 200)
    assert member_cohort_id == owner_cohort_id

    outsider_conn =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.assign(:current_user, outsider)
      |> RoomCryptoTopologyController.show(%{"scope_id" => channel.id})

    assert %{"error" => "not a member"} = json_response(outsider_conn, 403)
  end

  test "multi-cohort prepare and cutover are gated while single topology remains available", %{
    conn: conn
  } do
    previous = Application.get_env(:vesper, :multi_cohort_topology_mutations_enabled)
    Application.put_env(:vesper, :multi_cohort_topology_mutations_enabled, false)

    on_exit(fn ->
      Application.put_env(:vesper, :multi_cohort_topology_mutations_enabled, previous)
    end)

    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Topology mutation gate"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    rejected_prepare =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> RoomCryptoTopologyController.prepare(%{
        "scope_id" => channel.id,
        "mode" => "multi_cohort",
        "target_cohort_size" => 2,
        "request_id" => "disabled-prepare-request"
      })

    assert %{"error" => "multi_cohort_mutations_disabled"} =
             json_response(rejected_prepare, 409)

    single_update =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.assign(:current_user, owner)
      |> RoomCryptoTopologyController.update(%{
        "scope_id" => channel.id,
        "mode" => "single",
        "target_cohort_size" => 2
      })

    assert %{"topology" => %{"mode" => "single"}} = json_response(single_update, 200)

    assert {:ok, preparing} =
             Encryption.prepare_room_topology(
               room.id,
               :multi_cohort,
               2,
               "prepared-before-gate"
             )

    rejected_cutover =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.assign(:current_user, owner)
      |> RoomCryptoTopologyController.cutover(%{
        "scope_id" => channel.id,
        "topology_id" => preparing.id
      })

    assert %{"error" => "multi_cohort_mutations_disabled"} =
             json_response(rejected_cutover, 409)

    assert Vesper.Repo.get!(Vesper.Encryption.RoomTopology, preparing.id).state == :preparing
  end

  test "topology IDs cannot cross the authorized room boundary", %{conn: conn} do
    owner = insert_user()
    other_owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Authorized room"})
    {:ok, other_server} = Servers.create_server(other_owner, %{name: "Other room"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    other_channel = Enum.find(other_server.channels, &(&1.type == "text"))
    other_room = Runtime.get_room_for_channel(other_channel.id)

    assert {:ok, _single} = Encryption.ensure_room_topology(other_room.id)

    assert {:ok, other_topology} =
             Encryption.prepare_room_topology(other_room.id, :multi_cohort, 2)

    response =
      conn
      |> Plug.Conn.assign(:current_user, owner)
      |> RoomCryptoTopologyController.rollback(%{
        "scope_id" => channel.id,
        "topology_id" => other_topology.id
      })

    assert %{"error" => "topology_not_found"} = json_response(response, 404)

    assert Vesper.Repo.get!(Vesper.Encryption.RoomTopology, other_topology.id).state ==
             :preparing
  end
end
