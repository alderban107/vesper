Mix.Task.run("app.start")

defmodule AccountProfileFixture do
  alias Vesper.Accounts.User
  alias Vesper.Chat.{DmConversation, DmParticipant, Message}
  alias Vesper.Repo
  alias Vesper.Runtime.Room
  alias Vesper.ScopeSyncEvent
  alias Vesper.Servers.{Channel, Membership, Server}

  @chunk_size 1_000
  def run do
    case System.get_env("ACCOUNT_PROFILE_ACTION", "seed") do
      "seed" -> seed()
      "append_changes" -> append_changes()
      action -> raise "Unsupported ACCOUNT_PROFILE_ACTION=#{inspect(action)}"
    end
  end

  defp seed do
    user_id = required_env("ACCOUNT_PROFILE_USER_ID")
    fixture_path = required_env("ACCOUNT_PROFILE_FIXTURE_PATH")
    server_count = positive_int_env("ACCOUNT_PROFILE_SERVERS", 250)
    direct_dm_count = non_negative_int_env("ACCOUNT_PROFILE_DIRECT_DMS", 50_000)
    group_dm_count = non_negative_int_env("ACCOUNT_PROFILE_GROUP_DMS", 5_000)

    peer_count =
      max(positive_int_env("ACCOUNT_PROFILE_PEERS", 500), if(group_dm_count > 0, do: 4, else: 1))

    active_dm_count =
      min(
        non_negative_int_env("ACCOUNT_PROFILE_ACTIVE_DMS", 100),
        direct_dm_count + group_dm_count
      )

    now = DateTime.utc_now() |> DateTime.truncate(:second)
    run_slug = String.slice(String.replace(user_id, "-", ""), 0, 8)

    peer_ids = seed_peers(peer_count, run_slug, now)
    {server_ids, large_server_id} = seed_servers(user_id, server_count, run_slug, now)

    recent_conversation_ids =
      seed_conversations(
        user_id,
        peer_ids,
        direct_dm_count,
        group_dm_count,
        active_dm_count,
        now
      )

    fixture = %{
      user_id: user_id,
      peer_count: peer_count,
      server_count: server_count,
      direct_dm_count: direct_dm_count,
      group_dm_count: group_dm_count,
      total_conversation_count: direct_dm_count + group_dm_count,
      active_dm_count: active_dm_count,
      large_server_id: large_server_id,
      server_ids: Enum.take(server_ids, 500),
      recent_conversation_ids: recent_conversation_ids
    }

    File.write!(fixture_path, Jason.encode!(fixture, pretty: true))
  end

  defp append_changes do
    fixture_path = required_env("ACCOUNT_PROFILE_FIXTURE_PATH")
    fixture = fixture_path |> File.read!() |> Jason.decode!()
    relevant_count = positive_int_env("ACCOUNT_PROFILE_DELTA_CHANGES", 100)
    unrelated_count = non_negative_int_env("ACCOUNT_PROFILE_UNRELATED_CHANGES", 10_000)
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    conversation_ids = Map.fetch!(fixture, "recent_conversation_ids")

    if conversation_ids == [] do
      raise "The account profile fixture has no recent conversations"
    end

    total = relevant_count + unrelated_count

    events =
      for index <- 0..(total - 1) do
        relevant = index < relevant_count

        %{
          event_type: "message",
          scope_kind: "dm",
          scope_id:
            if(relevant,
              do: Enum.at(conversation_ids, rem(index, length(conversation_ids))),
              else: Ecto.UUID.generate()
            ),
          payload: %{"profile_index" => index},
          inserted_at: now
        }
      end

    insert_all(ScopeSyncEvent, events)
  end

  defp seed_peers(count, run_slug, now) do
    rows =
      for index <- 0..(count - 1) do
        id = Ecto.UUID.generate()

        {%{
           id: id,
           username: "p_#{run_slug}_#{Integer.to_string(index, 36)}",
           display_name: "Profile Peer #{index}",
           password_hash: "profile-fixture-only",
           status: "offline",
           inserted_at: now,
           updated_at: now
         }, id}
      end

    insert_all(User, Enum.map(rows, &elem(&1, 0)))
    Enum.map(rows, &elem(&1, 1))
  end

  defp seed_servers(user_id, count, run_slug, now) do
    rows =
      for index <- 0..(count - 1) do
        server_id = Ecto.UUID.generate()
        channel_id = Ecto.UUID.generate()
        room_id = Ecto.UUID.generate()

        %{
          server: %{
            id: server_id,
            name: "Profile Server #{index}",
            owner_id: user_id,
            invite_code: "p#{run_slug}#{Integer.to_string(index, 36)}" |> String.slice(0, 16),
            inserted_at: now,
            updated_at: now
          },
          membership: %{
            id: Ecto.UUID.generate(),
            user_id: user_id,
            server_id: server_id,
            channel_id: nil,
            role: "owner",
            joined_at: now
          },
          channel: %{
            id: channel_id,
            server_id: server_id,
            name: "general",
            type: "text",
            position: 0,
            inserted_at: now,
            updated_at: now
          },
          room: %{
            id: room_id,
            kind: :channel,
            server_id: server_id,
            channel_id: channel_id,
            conversation_id: nil,
            current_seq: 0,
            activity_at: now,
            inserted_at: now,
            updated_at: now
          }
        }
      end

    insert_all(Server, Enum.map(rows, & &1.server))
    insert_all(Membership, Enum.map(rows, & &1.membership))
    insert_all(Channel, Enum.map(rows, & &1.channel))
    insert_all(Room, Enum.map(rows, & &1.room))

    server_ids = Enum.map(rows, & &1.server.id)
    {server_ids, List.first(server_ids)}
  end

  defp seed_conversations(
         user_id,
         peer_ids,
         direct_count,
         group_count,
         active_count,
         now
       ) do
    total = direct_count + group_count

    if total == 0 do
      []
    else
      0..(total - 1)
      |> Stream.chunk_every(@chunk_size)
      |> Enum.reduce([], fn indexes, recent_ids ->
        rows =
          Enum.map(indexes, fn index ->
            group = index >= direct_count
            channel_id = Ecto.UUID.generate()
            conversation_id = Ecto.UUID.generate()
            activity_at = DateTime.add(now, -index, :second)
            message_id = if index < active_count, do: Ecto.UUID.generate(), else: nil

            participant_peer_ids =
              if group do
                0..3
                |> Enum.map(&Enum.at(peer_ids, rem(index + &1, length(peer_ids))))
                |> Enum.uniq()
              else
                [Enum.at(peer_ids, rem(index, length(peer_ids)))]
              end

            participant_ids = [user_id | participant_peer_ids]

            %{
              channel: %{
                id: channel_id,
                server_id: nil,
                name: nil,
                type: if(group, do: "group_dm", else: "dm"),
                position: 0,
                inserted_at: activity_at,
                updated_at: activity_at
              },
              conversation: %{
                id: conversation_id,
                type: if(group, do: "group", else: "direct"),
                name: if(group, do: "Profile Group #{index - direct_count}", else: nil),
                channel_id: channel_id,
                inserted_at: activity_at
              },
              participants:
                Enum.map(participant_ids, fn participant_id ->
                  %{
                    id: Ecto.UUID.generate(),
                    conversation_id: conversation_id,
                    user_id: participant_id,
                    joined_at: activity_at
                  }
                end),
              memberships:
                Enum.map(participant_ids, fn participant_id ->
                  %{
                    id: Ecto.UUID.generate(),
                    user_id: participant_id,
                    server_id: nil,
                    channel_id: channel_id,
                    role: "member",
                    joined_at: activity_at
                  }
                end),
              message:
                if(message_id,
                  do: %{
                    id: message_id,
                    conversation_id: conversation_id,
                    channel_id: nil,
                    sender_id: hd(participant_peer_ids),
                    ciphertext: :crypto.strong_rand_bytes(64),
                    mls_epoch: 1,
                    encryption_scheme: "mls",
                    encryption_group_id: channel_id,
                    client_nonce: "profile-#{conversation_id}",
                    is_reply: false,
                    inserted_at: activity_at,
                    updated_at: activity_at
                  },
                  else: nil
                ),
              room: %{
                id: Ecto.UUID.generate(),
                kind: :dm,
                server_id: nil,
                channel_id: nil,
                conversation_id: conversation_id,
                current_seq: if(message_id, do: 1, else: 0),
                activity_at: activity_at,
                last_message_id: message_id,
                last_message_at: activity_at,
                last_message_seq: if(message_id, do: 1, else: nil),
                inserted_at: activity_at,
                updated_at: activity_at
              }
            }
          end)

        insert_all(Channel, Enum.map(rows, & &1.channel))
        insert_all(DmConversation, Enum.map(rows, & &1.conversation))
        insert_all(DmParticipant, Enum.flat_map(rows, & &1.participants))
        insert_all(Membership, Enum.flat_map(rows, & &1.memberships))
        insert_all(Message, rows |> Enum.map(& &1.message) |> Enum.reject(&is_nil/1))
        insert_all(Room, Enum.map(rows, & &1.room))

        recent =
          rows
          |> Enum.filter(fn row -> not is_nil(row.message) end)
          |> Enum.map(& &1.conversation.id)

        recent_ids ++ recent
      end)
    end
  end

  defp insert_all(_source, []), do: :ok

  defp insert_all(source, rows) do
    rows
    |> Enum.chunk_every(@chunk_size)
    |> Enum.each(fn chunk -> Repo.insert_all(source, chunk, timeout: :infinity) end)
  end

  defp required_env(name) do
    System.get_env(name) || raise "Missing #{name}"
  end

  defp positive_int_env(name, fallback) do
    case Integer.parse(System.get_env(name, Integer.to_string(fallback))) do
      {value, ""} when value > 0 -> value
      _ -> raise "#{name} must be a positive integer"
    end
  end

  defp non_negative_int_env(name, fallback) do
    case Integer.parse(System.get_env(name, Integer.to_string(fallback))) do
      {value, ""} when value >= 0 -> value
      _ -> raise "#{name} must be a non-negative integer"
    end
  end
end

AccountProfileFixture.run()
