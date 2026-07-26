defmodule VesperWeb.CohortChannelTest do
  use Vesper.ChannelCase, async: false

  alias Vesper.Encryption
  alias Vesper.Encryption.MlsEvent
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Servers

  test "cohort control events stay on the assigned cohort and retain room authorization" do
    owner = insert_user()
    peer = insert_user()
    other_cohort_user = insert_user()
    outsider = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Cohort control"})
    {:ok, _} = Servers.join_server(peer, server.invite_code)
    {:ok, _} = Servers.join_server(other_cohort_user, server.invite_code)
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _single} = Encryption.ensure_room_topology(room.id)
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 2)
    assert {:ok, _active} = Encryption.activate_room_topology(preparing.id, room.current_seq)
    assert {:ok, owner_resolution} = Encryption.resolve_room_topology(room.id, owner.id)
    assert {:ok, peer_resolution} = Encryption.resolve_room_topology(room.id, peer.id)

    assert {:ok, other_resolution} =
             Encryption.resolve_room_topology(room.id, other_cohort_user.id)

    assert owner_resolution.group_id == peer_resolution.group_id
    refute owner_resolution.group_id == other_resolution.group_id

    owner_socket = connect_user_socket(owner, "cohort-owner")
    peer_socket = connect_user_socket(peer, "cohort-peer")
    other_socket = connect_user_socket(other_cohort_user, "cohort-other")
    outsider_socket = connect_user_socket(outsider, "cohort-outsider")

    {:ok, _, owner_socket} =
      subscribe_and_join(owner_socket, "crypto:cohort:#{owner_resolution.group_id}")

    {:ok, _, _peer_socket} =
      subscribe_and_join(peer_socket, "crypto:cohort:#{peer_resolution.group_id}")

    {:ok, _, _other_socket} =
      subscribe_and_join(other_socket, "crypto:cohort:#{other_resolution.group_id}")

    assert {:error, %{reason: "cohort not found or not assigned"}} =
             subscribe_and_join(outsider_socket, "crypto:cohort:#{owner_resolution.group_id}")

    ref = push(owner_socket, "mls_request_join_all", %{})
    assert_reply ref, :ok, %{seq: seq}

    stored = Repo.get_by!(MlsEvent, id: seq)
    assert stored.group_id == owner_resolution.group_id
    assert stored.channel_id == channel.id

    join_ref = push(owner_socket, "mls_request_join", %{"device_id" => "owner-device"})
    assert_reply join_ref, :ok

    owner_topic = "crypto:cohort:#{owner_resolution.group_id}"
    other_topic = "crypto:cohort:#{other_resolution.group_id}"

    assert_receive %Phoenix.Socket.Broadcast{
      topic: ^owner_topic,
      event: "mls_request_join",
      payload: %{user_id: user_id}
    }

    assert user_id == owner.id

    refute_receive %Phoenix.Socket.Broadcast{
                     topic: ^other_topic,
                     event: "mls_request_join",
                     payload: %{user_id: ^user_id}
                   },
                   50
  end
end
