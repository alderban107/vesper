defmodule Vesper.VoicePeerConnectionTest do
  use ExUnit.Case, async: false

  alias ExWebRTC.PeerConnection

  test "an offered but unconnected peer closes without crashing its DTLS transport" do
    {:ok, peer_connection} =
      PeerConnection.start_link(ice_servers: [], controlling_process: self())

    Process.unlink(peer_connection)

    {:ok, _transceiver} =
      PeerConnection.add_transceiver(peer_connection, :audio, direction: :recvonly)

    {:ok, offer} = PeerConnection.create_offer(peer_connection)
    assert :ok = PeerConnection.set_local_description(peer_connection, offer)
    assert :ok = PeerConnection.close(peer_connection)
    assert Process.alive?(peer_connection)

    GenServer.stop(peer_connection)
  end
end
