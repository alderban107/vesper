defmodule Vesper.SyncCursorTest do
  use ExUnit.Case, async: true

  alias Vesper.SyncCursor

  describe "encode/decode round-trip with DateTime" do
    test "encodes and decodes a bare DateTime" do
      dt = ~U[2026-03-24 12:30:45Z]
      cursor = SyncCursor.encode(dt)

      assert is_binary(cursor)

      result = SyncCursor.decode(cursor)
      # decode shifts back 1 second
      assert result.synced_at == ~U[2026-03-24 12:30:44Z]
      assert result.user_sync_event_id == nil
    end

    test "truncates sub-second precision on encode" do
      dt = ~U[2026-03-24 12:30:45.123456Z]
      cursor = SyncCursor.encode(dt)
      result = SyncCursor.decode(cursor)

      # Truncated to :second (45) then shifted back 1s (44)
      assert result.synced_at == ~U[2026-03-24 12:30:44Z]
    end
  end

  describe "encode/decode round-trip with map payload" do
    test "round-trips a map with synced_at and user_sync_event_id" do
      dt = ~U[2026-03-24 08:00:00Z]
      payload = %{synced_at: dt, user_sync_event_id: 42}
      cursor = SyncCursor.encode(payload)

      assert is_binary(cursor)

      result = SyncCursor.decode(cursor)
      # decode shifts back 1 second
      assert result.synced_at == ~U[2026-03-24 07:59:59Z]
      assert result.user_sync_event_id == 42
    end

    test "preserves nil user_sync_event_id through round-trip" do
      dt = ~U[2026-01-01 00:00:00Z]
      payload = %{synced_at: dt, user_sync_event_id: nil}
      cursor = SyncCursor.encode(payload)

      result = SyncCursor.decode(cursor)
      assert result.user_sync_event_id == nil
    end
  end

  describe "decode/1 edge cases" do
    test "returns nil for nil input" do
      assert SyncCursor.decode(nil) == nil
    end

    test "returns nil for garbage binary" do
      assert SyncCursor.decode("not-a-valid-cursor!!!") == nil
    end

    test "returns nil for non-binary, non-nil input" do
      assert SyncCursor.decode(12345) == nil
      assert SyncCursor.decode(%{}) == nil
    end
  end

  describe "synced_at shift" do
    test "shifts synced_at back by exactly 1 second on decode" do
      dt = ~U[2026-06-15 18:30:00Z]
      cursor = SyncCursor.encode(dt)
      result = SyncCursor.decode(cursor)

      expected = DateTime.add(dt, -1, :second)
      assert result.synced_at == expected
    end

    test "shifts map-encoded synced_at back by exactly 1 second" do
      dt = ~U[2026-06-15 18:30:00Z]
      cursor = SyncCursor.encode(%{synced_at: dt, user_sync_event_id: 99})
      result = SyncCursor.decode(cursor)

      expected = DateTime.add(dt, -1, :second)
      assert result.synced_at == expected
      assert result.user_sync_event_id == 99
    end
  end
end
