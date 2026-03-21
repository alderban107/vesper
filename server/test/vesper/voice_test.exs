defmodule Vesper.VoiceTest do
  # async: false because PeerConnection's DTLS NIF isn't async-safe
  use Vesper.DataCase, async: false

  # Suppress noisy DTLS NIF crash logs during PeerConnection cleanup
  @moduletag capture_log: true

  alias Vesper.Voice

  describe "ensure_room/2" do
    test "creates a room if one doesn't exist" do
      room_id = Ecto.UUID.generate()
      assert :ok = Voice.ensure_room(room_id)
      # Room should now be findable
      assert [{_pid, _}] = Registry.lookup(Vesper.Voice.Registry, room_id)
    end

    test "is idempotent" do
      room_id = Ecto.UUID.generate()
      assert :ok = Voice.ensure_room(room_id)
      assert :ok = Voice.ensure_room(room_id)
      # Only one process should be registered
      assert [{_pid, _}] = Registry.lookup(Vesper.Voice.Registry, room_id)
    end
  end

  describe "join_room/3 and leave_room/2" do
    test "joining returns an offer SDP and track map" do
      room_id = Ecto.UUID.generate()
      user_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      {:ok, offer_sdp, track_map} = Voice.join_room(room_id, user_id, self())

      assert is_binary(offer_sdp)
      assert String.contains?(offer_sdp, "v=0")
      assert is_map(track_map)
    end

    test "participants are tracked" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      {:ok, _, _} = Voice.join_room(room_id, "user1", self())
      participants = Voice.get_participants(room_id)
      assert length(participants) == 1
      assert hd(participants).user_id == "user1"
    end

    test "leaving removes participant and room stops after idle timeout" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      [{room_pid, _}] = Registry.lookup(Vesper.Voice.Registry, room_id)
      ref = Process.monitor(room_pid)

      pid = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, _, _} = Voice.join_room(room_id, "user1", pid)
      assert :ok = Voice.leave_room(room_id, "user1")

      # Room doesn't stop immediately — trigger idle timeout
      send(room_pid, :idle_timeout)
      assert_receive {:DOWN, ^ref, :process, ^room_pid, :normal}, 5000
      :timer.sleep(50)
      assert [] = Registry.lookup(Vesper.Voice.Registry, room_id)
    end

    test "room stops after idle timeout when last participant leaves" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      [{room_pid, _}] = Registry.lookup(Vesper.Voice.Registry, room_id)
      ref = Process.monitor(room_pid)

      pid1 = spawn(fn -> Process.sleep(:infinity) end)
      pid2 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, _, _} = Voice.join_room(room_id, "user1", pid1)
      {:ok, _, _} = Voice.join_room(room_id, "user2", pid2)

      assert length(Voice.get_participants(room_id)) == 2

      Voice.leave_room(room_id, "user1")
      :timer.sleep(50)
      assert length(Voice.get_participants(room_id)) == 1

      Voice.leave_room(room_id, "user2")
      # Room doesn't stop immediately — trigger idle timeout
      send(room_pid, :idle_timeout)
      assert_receive {:DOWN, ^ref, :process, ^room_pid, :normal}, 5000
      :timer.sleep(50)
      assert [] = Registry.lookup(Vesper.Voice.Registry, room_id)
    end
  end

  describe "max participants" do
    test "rejects join when room is full" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      # Fill the room to capacity (25)
      for i <- 1..25 do
        pid = spawn(fn -> Process.sleep(:infinity) end)
        {:ok, _, _} = Voice.join_room(room_id, "user#{i}", pid)
      end

      pid = spawn(fn -> Process.sleep(:infinity) end)
      assert {:error, :room_full} = Voice.join_room(room_id, "user26", pid)
    end
  end

  describe "set_muted/3" do
    test "updates muted state for participant" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id)

      {:ok, _, _} = Voice.join_room(room_id, "user1", self())
      Voice.set_muted(room_id, "user1", true)

      # set_muted is a cast — give it a moment to process
      :timer.sleep(50)

      participants = Voice.get_participants(room_id)
      assert hd(participants).muted == true
    end
  end

  describe "get_participants/1" do
    test "returns empty list for non-existent room" do
      assert [] = Voice.get_participants("nonexistent")
    end
  end

  describe "DM call state" do
    test "call_ring sets ringing state" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id, room_type: :dm)

      {:ok, _, _} = Voice.join_room(room_id, "caller", self())
      assert :ok = Voice.call_ring(room_id, "caller")
    end

    test "call_accept transitions from ringing to active" do
      room_id = Ecto.UUID.generate()
      Voice.ensure_room(room_id, room_type: :dm)

      {:ok, _, _} = Voice.join_room(room_id, "caller", self())
      Voice.call_ring(room_id, "caller")
      assert :ok = Voice.call_accept(room_id)
    end
  end
end
