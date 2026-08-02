defmodule Vesper.Servers.InviteTest do
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.Repo
  alias Vesper.Servers
  alias Vesper.Servers.{Invite, Membership}

  describe "use_invite/2" do
    test "admits at most max_uses members under concurrent redemption" do
      owner = insert_user()
      first_user = insert_user()
      second_user = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "Concurrent invite"})
      {:ok, invite} = Servers.create_invite(server.id, owner.id, %{max_uses: 1})

      parent = self()
      start_ref = make_ref()

      tasks =
        [first_user, second_user]
        |> Enum.map(fn user ->
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            send(parent, {:ready, self()})

            receive do
              {:go, ^start_ref} -> :ok
            end

            Servers.use_invite(invite.code, user)
          end)
        end)

      for _ <- tasks do
        assert_receive {:ready, _pid}, 1_000
      end

      Enum.each(tasks, fn task -> send(task.pid, {:go, start_ref}) end)
      results = Enum.map(tasks, &Task.await(&1, 5_000))

      assert Enum.count(results, &match?({:ok, _server}, &1)) == 1
      assert Enum.count(results, &(&1 == {:error, :max_uses_reached})) == 1

      admitted_user_ids =
        Repo.all(
          from(membership in Membership,
            where:
              membership.server_id == ^server.id and
                membership.user_id in ^[first_user.id, second_user.id],
            select: membership.user_id
          )
        )

      assert length(admitted_user_ids) == 1
      assert Repo.get!(Invite, invite.id).uses == 1
    end

    test "does not consume another use when the same member redeems twice" do
      owner = insert_user()
      member = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "Idempotent invite"})
      {:ok, invite} = Servers.create_invite(server.id, owner.id, %{max_uses: 2})

      assert {:ok, _server} = Servers.use_invite(invite.code, member)
      assert {:ok, _server} = Servers.use_invite(invite.code, member)

      assert Repo.aggregate(
               from(membership in Membership,
                 where: membership.server_id == ^server.id and membership.user_id == ^member.id
               ),
               :count
             ) == 1

      assert Repo.get!(Invite, invite.id).uses == 1
    end
  end
end
