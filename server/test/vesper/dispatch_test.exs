defmodule Vesper.DispatchTest do
  use Vesper.DataCase, async: false

  alias Oban.Testing
  alias Vesper.Dispatch
  alias Vesper.DispatchOutbox
  alias Vesper.Encryption
  alias Vesper.Repo

  test "broadcast failure preserves the accepted event and retry delivers once" do
    sender = insert_user()
    group_id = Ecto.UUID.generate()

    Testing.with_testing_mode(:manual, fn ->
      assert {:ok, event} =
               Encryption.store_mls_commit_event(%{
                 group_id: group_id,
                 event_type: "mls_commit",
                 payload: %{commit_data: "commit-a"},
                 sender_id: sender.id,
                 sender_device_id: "device-a"
               })

      dispatch = Repo.get_by!(DispatchOutbox, durable_key: "mls_event:#{event.id}")
      assert dispatch.status == "pending"

      assert {:error, "injected broadcast failure"} =
               Dispatch.deliver(dispatch.id, fn _topic, _event, _payload ->
                 raise "injected broadcast failure"
               end)

      event_id = event.id
      assert [%{id: ^event_id}] = Encryption.list_mls_events_after(group_id)
      assert Repo.get!(DispatchOutbox, dispatch.id).status == "failed"

      parent = self()

      assert :ok =
               Dispatch.deliver(dispatch.id, fn topic, emitted_event, payload ->
                 send(parent, {:broadcast, topic, emitted_event, payload})
                 :ok
               end)

      assert_receive {:broadcast, topic, "mls_commit", payload}
      assert topic == "group:#{group_id}"
      assert payload["dispatch_id"] == "mls_event:#{event.id}"

      assert :ok = Dispatch.deliver(dispatch.id, fn _, _, _ -> flunk("duplicate broadcast") end)
      refute_receive {:broadcast, _, _, _}
    end)
  end

  test "per-scope dispatch waits for the previous durable event" do
    sender = insert_user()
    group_id = Ecto.UUID.generate()

    Testing.with_testing_mode(:manual, fn ->
      events =
        Enum.map(["first", "second"], fn commit_data ->
          assert {:ok, event} =
                   Encryption.store_mls_commit_event(%{
                     group_id: group_id,
                     event_type: "mls_commit",
                     payload: %{commit_data: commit_data},
                     sender_id: sender.id,
                     sender_device_id: "device-a"
                   })

          event
        end)

      [first, second] = Enum.sort_by(events, & &1.id)
      first_dispatch = Repo.get_by!(DispatchOutbox, durable_key: "mls_event:#{first.id}")
      second_dispatch = Repo.get_by!(DispatchOutbox, durable_key: "mls_event:#{second.id}")
      parent = self()

      emit = fn _topic, _event, payload ->
        send(parent, {:delivered, payload["seq"]})
        :ok
      end

      assert {:snooze, 1} = Dispatch.deliver(second_dispatch.id, emit)
      assert :ok = Dispatch.deliver(first_dispatch.id, emit)
      assert :ok = Dispatch.deliver(second_dispatch.id, emit)
      assert_receive {:delivered, first_id}
      assert_receive {:delivered, second_id}
      assert first_id == first.id
      assert second_id == second.id
    end)
  end

  test "backlog telemetry exposes depth age attempts and failures" do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    %DispatchOutbox{}
    |> DispatchOutbox.changeset(%{
      durable_key: "test:backlog",
      scope_key: "channel:backlog",
      scope_topic: "chat:channel:backlog",
      ordering_key: 1,
      event: "new_message",
      status: "failed",
      attempt_count: 3,
      last_error: "offline"
    })
    |> Repo.insert!()

    metrics = Dispatch.backlog_metrics(now)
    assert metrics.depth == 1
    assert metrics.oldest_age_seconds >= 0
    assert metrics.attempts == 3
    assert metrics.failures == 1
  end
end
