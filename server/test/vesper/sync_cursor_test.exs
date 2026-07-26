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

    test "preserves a bounded page high-water mark through round-trip" do
      cursor =
        SyncCursor.encode(%{
          synced_at: ~U[2026-07-26 12:00:00Z],
          user_sync_event_id: 42,
          scope_sync_event_id: 84,
          user_sync_high_water: 100,
          scope_sync_high_water: 200
        })

      result = SyncCursor.decode(cursor)
      assert result.user_sync_high_water == 100
      assert result.scope_sync_high_water == 200
    end

    test "uses a compact versioned wire format" do
      payload = %{
        synced_at: ~U[2026-07-26 12:00:00Z],
        user_sync_event_id: 42,
        scope_sync_event_id: 84,
        user_sync_high_water: 100,
        scope_sync_high_water: 200
      }

      cursor = SyncCursor.encode(payload)
      {:ok, decoded} = Base.url_decode64(cursor, padding: false)

      assert Jason.decode!(decoded) == [1, 1_785_067_200, 42, 84, 100, 200]

      legacy_cursor =
        payload
        |> Map.put(:synced_at, "2026-07-26T12:00:00Z")
        |> Jason.encode!()
        |> Base.url_encode64(padding: false)

      assert byte_size(cursor) < byte_size(legacy_cursor) / 2
    end

    test "decodes legacy map cursors already persisted by clients" do
      cursor =
        %{
          synced_at: "2026-07-26T12:00:00Z",
          user_sync_event_id: 42,
          scope_sync_event_id: 84,
          user_sync_high_water: 100,
          scope_sync_high_water: 200
        }
        |> Jason.encode!()
        |> Base.url_encode64(padding: false)

      assert SyncCursor.decode(cursor) == %{
               synced_at: ~U[2026-07-26 11:59:59Z],
               user_sync_event_id: 42,
               scope_sync_event_id: 84,
               user_sync_high_water: 100,
               scope_sync_high_water: 200
             }
    end

    test "preserves nil user_sync_event_id through round-trip" do
      dt = ~U[2026-01-01 00:00:00Z]
      payload = %{synced_at: dt, user_sync_event_id: nil}
      cursor = SyncCursor.encode(payload)

      result = SyncCursor.decode(cursor)
      assert result.user_sync_event_id == nil
    end
  end

  describe "retention" do
    test "accepts cursors inside the configured event retention window" do
      now = ~U[2026-07-26 12:00:00Z]
      cursor = %{synced_at: DateTime.add(now, -6 * 86_400, :second)}

      assert SyncCursor.retained?(cursor, now)
    end

    test "rejects cursors older than the configured event retention window" do
      now = ~U[2026-07-26 12:00:00Z]
      cursor = %{synced_at: DateTime.add(now, -8 * 86_400, :second)}

      refute SyncCursor.retained?(cursor, now)
    end
  end

  describe "decode/1 edge cases" do
    test "returns nil for nil input" do
      assert SyncCursor.decode(nil) == nil
    end

    test "returns nil for garbage binary" do
      assert SyncCursor.decode("not-a-valid-cursor!!!") == nil
    end

    test "returns nil for unknown or malformed compact cursors" do
      for payload <- [[2, 1_753_531_200], [1, "not-unix-seconds"], [1, 1_753_531_200, 42]] do
        cursor = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
        assert SyncCursor.decode(cursor) == nil
      end
    end

    test "decodes legacy bare timestamp cursors" do
      cursor = Base.url_encode64("2026-03-24T12:30:45Z", padding: false)

      assert SyncCursor.decode(cursor) == %{
               synced_at: ~U[2026-03-24 12:30:44Z],
               user_sync_event_id: nil
             }
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
