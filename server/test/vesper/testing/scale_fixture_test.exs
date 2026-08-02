defmodule Vesper.Testing.ScaleFixtureTest do
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.Encryption.RoomHistoryAuthorization
  alias Vesper.Repo
  alias Vesper.Runtime.Room
  alias Vesper.Testing.ScaleFixture

  test "bulk fixtures satisfy current room and application-tenure invariants" do
    fixture =
      ScaleFixture.build(%{
        label: "fixture_contract",
        user_count: 2,
        channel_count: 2,
        active_channel_count: 1,
        secondary_every: 1
      })

    rooms =
      Repo.all(
        from room in Room,
          where: room.server_id == ^fixture.server.id,
          order_by: room.channel_id
      )

    assert length(rooms) == 2
    assert Enum.all?(rooms, &match?(%DateTime{}, &1.activity_at))

    authorization_count =
      Repo.aggregate(
        from(authorization in RoomHistoryAuthorization,
          join: room in Room,
          on: room.id == authorization.room_id,
          where: room.server_id == ^fixture.server.id
        ),
        :count
      )

    # The fixture owner and both generated members receive one current-tenure
    # authorization per room.
    assert authorization_count == 2 * 3
  end
end
