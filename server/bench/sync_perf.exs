Logger.configure(level: :warning)
Mix.Task.run("app.start")

alias Vesper.{Accounts, Chat, Repo, Servers, SyncCursor}
alias Vesper.Accounts.User
alias Vesper.Chat.{DmConversation, DmParticipant, DmReadPosition, Message}
alias Vesper.Servers.{Channel, Membership, Server}
alias VesperWeb.Endpoint
import Ecto.Query
import Plug.Conn

env_int = fn name, default ->
  case System.get_env(name) do
    nil ->
      default

    value ->
      case Integer.parse(value) do
        {parsed, _rest} when parsed > 0 -> parsed
        _ -> default
      end
  end
end

run_count = env_int.("BENCH_RUNS", 10)
channel_count = env_int.("BENCH_CHANNEL_COUNT", 400)
channel_messages_per_scope = env_int.("BENCH_CHANNEL_MESSAGES", 8)
conversation_count = env_int.("BENCH_DM_COUNT", 120)
conversation_messages_per_scope = env_int.("BENCH_DM_MESSAGES", 6)
channel_read_positions = env_int.("BENCH_CHANNEL_READ_POSITIONS", min(80, channel_count))
conversation_read_positions = env_int.("BENCH_DM_READ_POSITIONS", min(40, conversation_count))
channel_mutation_count = env_int.("BENCH_CHANNEL_MUTATIONS", min(120, channel_count))
conversation_mutation_count = env_int.("BENCH_DM_MUTATIONS", min(60, conversation_count))
delta_channel_message_count = env_int.("BENCH_DELTA_CHANNEL_MESSAGES", min(24, channel_count))
delta_conversation_message_count = env_int.("BENCH_DELTA_DM_MESSAGES", min(12, conversation_count))
delta_channel_mutation_count = env_int.("BENCH_DELTA_CHANNEL_MUTATIONS", min(16, channel_count))
delta_conversation_mutation_count = env_int.("BENCH_DELTA_DM_MUTATIONS", min(8, conversation_count))
scope_sync_channel_count = env_int.("BENCH_SCOPE_SYNC_CHANNELS", min(12, channel_count))
scope_sync_conversation_count = env_int.("BENCH_SCOPE_SYNC_DMS", min(8, conversation_count))

IO.puts(
  "config|runs=#{run_count}|channels=#{channel_count}|channel_messages=#{channel_messages_per_scope}|dms=#{conversation_count}|dm_messages=#{conversation_messages_per_scope}|channel_mutations=#{channel_mutation_count}|dm_mutations=#{conversation_mutation_count}"
)

now = DateTime.utc_now() |> DateTime.truncate(:second)
uid = Ecto.UUID.generate()
server_id = Ecto.UUID.generate()
username = "bench_#{System.unique_integer([:positive])}"

user =
  Repo.insert!(%User{
    id: uid,
    username: username,
    password_hash: Argon2.hash_pwd_salt("benchpass"),
    inserted_at: now,
    updated_at: now
  })

{:ok, device} =
  Accounts.ensure_device(
    user,
    %{
      client_id: "bench-#{System.unique_integer([:positive])}",
      name: "Bench Device",
      platform: "bench"
    },
    "trusted"
  )

{:ok, tokens} = Accounts.create_tokens(user, device)

server =
  Repo.insert!(%Server{
    id: server_id,
    name: "bench_server_#{System.unique_integer([:positive])}",
    owner_id: user.id,
    invite_code: Base.url_encode64(:crypto.strong_rand_bytes(6)),
    invite_code_rotated_at: now,
    inserted_at: now,
    updated_at: now
  })

Repo.insert!(%Membership{
  id: Ecto.UUID.generate(),
  user_id: user.id,
  server_id: server.id,
  role: "owner",
  joined_at: now
})

channel_ids =
  for idx <- 1..channel_count do
    channel =
      Repo.insert!(%Channel{
        id: Ecto.UUID.generate(),
        server_id: server.id,
        name: "bench-#{idx}",
        type: "text",
        position: idx,
        inserted_at: now,
        updated_at: now
      })

    {:ok, _room} = Vesper.Runtime.ensure_room_for_channel(channel)

    for midx <- 1..channel_messages_per_scope do
      inserted = DateTime.add(now, -(idx * 10 + midx), :second)

      message =
        Repo.insert!(%Message{
          id: Ecto.UUID.generate(),
          channel_id: channel.id,
          sender_id: user.id,
          content: nil,
          ciphertext: <<1, 2, 3>>,
          mls_epoch: 0,
          inserted_at: inserted,
          updated_at: inserted
        })

      Vesper.Runtime.project_message(message)
    end

    channel.id
  end

conversation_ids =
  for idx <- 1..conversation_count do
    conversation =
      Repo.insert!(%DmConversation{
        id: Ecto.UUID.generate(),
        type: "direct",
        name: nil,
        inserted_at: now
      })

    {:ok, _room} = Vesper.Runtime.ensure_room_for_conversation(conversation)

    Repo.insert!(%DmParticipant{
      id: Ecto.UUID.generate(),
      conversation_id: conversation.id,
      user_id: user.id,
      joined_at: now
    })

    for midx <- 1..conversation_messages_per_scope do
      inserted = DateTime.add(now, -(idx * 10 + midx), :second)

      message =
        Repo.insert!(%Message{
          id: Ecto.UUID.generate(),
          conversation_id: conversation.id,
          sender_id: user.id,
          content: nil,
          ciphertext: <<4, 5, 6>>,
          mls_epoch: 0,
          inserted_at: inserted,
          updated_at: inserted
        })

      Vesper.Runtime.project_message(message)
    end

    conversation.id
  end

for channel_id <- Enum.take(channel_ids, channel_read_positions) do
  Repo.insert!(%Vesper.Chat.ChannelReadPosition{
    id: Ecto.UUID.generate(),
    user_id: user.id,
    channel_id: channel_id,
    last_read_at: DateTime.add(now, -120, :second)
  })
end

for conversation_id <- Enum.take(conversation_ids, conversation_read_positions) do
  Repo.insert!(%DmReadPosition{
    id: Ecto.UUID.generate(),
    user_id: user.id,
    conversation_id: conversation_id,
    last_read_at: DateTime.add(now, -120, :second)
  })
end

scope_since = DateTime.add(now, -3600, :second)
mutation_since = DateTime.add(now, -60, :second)

for channel_id <- Enum.take(channel_ids, channel_mutation_count) do
  {:ok, _event} =
    Vesper.Runtime.append_scope_event("channel", channel_id, user.id, "message_edited", %{
      message_id: Ecto.UUID.generate()
    })
end

for conversation_id <- Enum.take(conversation_ids, conversation_mutation_count) do
  {:ok, _event} =
    Vesper.Runtime.append_scope_event("dm", conversation_id, user.id, "message_deleted", %{
      message_id: Ecto.UUID.generate()
    })
end

build_conn = fn method, path, body ->
  conn =
    Plug.Test.conn(method, path, body)
    |> put_req_header("authorization", "Bearer #{tokens.access_token}")

  case method do
    "POST" -> put_req_header(conn, "content-type", "application/json")
    _ -> conn
  end
end

measure = fn label, fun ->
  runs = run_count

  {times, sizes} =
    Enum.reduce(1..runs, {[], []}, fn _, {time_acc, size_acc} ->
      {microseconds, result} = :timer.tc(fun)
      {payload_size, _decoded} = result
      {[microseconds / 1000 | time_acc], [payload_size | size_acc]}
    end)

  sorted = Enum.sort(times)
  size_sorted = Enum.sort(sizes)
  p95_index = max(0, min(runs - 1, trunc(Float.ceil(runs * 0.95)) - 1))

  avg_ms = Enum.sum(times) / runs
  avg_bytes = Enum.sum(sizes) / runs

  IO.puts(
    "#{label}|avg_ms=#{Float.round(avg_ms, 2)}|p95_ms=#{Float.round(Enum.at(sorted, p95_index), 2)}|min_ms=#{Float.round(Enum.min(times), 2)}|max_ms=#{Float.round(Enum.max(times), 2)}|avg_kb=#{Float.round(avg_bytes / 1024, 2)}|p95_kb=#{Float.round(Enum.at(size_sorted, p95_index) / 1024, 2)}"
  )
end

measure.("list_user_channel_ids_#{channel_count}", fn ->
  result = Servers.list_user_channel_ids(user.id)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("latest_channel_messages_#{channel_count}", fn ->
  result = Chat.get_latest_channel_messages(channel_ids)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("channel_activity_snapshots_#{channel_count}", fn ->
  result = Servers.list_channel_activity_snapshots(user.id, channel_ids)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("channel_unreads_#{channel_count}", fn ->
  result = Chat.get_channel_unread_counts_snapshot(user.id, channel_ids)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("latest_conversation_messages_#{conversation_count}", fn ->
  result = Chat.get_latest_conversation_messages(conversation_ids)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("dm_unreads_#{conversation_count}", fn ->
  result = Chat.get_dm_unread_counts_snapshot(user.id, conversation_ids)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("list_changed_channel_ids_#{channel_mutation_count}", fn ->
  result = Servers.list_changed_channel_ids_since(user.id, mutation_since)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("list_changed_conversation_ids_#{conversation_mutation_count}", fn ->
  result = Chat.list_changed_conversation_ids_since(user.id, mutation_since)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("list_scope_events_channel", fn ->
  result = Vesper.Runtime.list_scope_events("channel", hd(channel_ids), scope_since, limit: 200)
  {byte_size(:erlang.term_to_binary(result)), result}
end)

measure.("http_sync_full", fn ->
  conn = build_conn.("GET", "/api/v1/sync", nil) |> Endpoint.call([])
  if conn.status != 200, do: raise("full sync failed with #{conn.status}")
  {byte_size(conn.resp_body), Jason.decode!(conn.resp_body)}
end)

delta_token_conn = build_conn.("GET", "/api/v1/sync", nil) |> Endpoint.call([])
delta_token = Jason.decode!(delta_token_conn.resp_body)["token"]
scope_channel_ids = Enum.take(channel_ids, scope_sync_channel_count)
scope_conversation_ids = Enum.take(conversation_ids, scope_sync_conversation_count)

scope_after_seqs =
  Map.new(scope_channel_ids, fn channel_id ->
    room = Vesper.Runtime.get_room_for_channel(channel_id)
    {{"channel", channel_id}, room.current_seq || 0}
  end)
  |> Map.merge(
    Map.new(scope_conversation_ids, fn conversation_id ->
      room = Vesper.Runtime.get_room_for_conversation(conversation_id)
      {{"dm", conversation_id}, room.current_seq || 0}
    end)
  )

for channel_id <- Enum.take(channel_ids, delta_channel_message_count) do
  inserted = DateTime.add(now, 30, :second)

  message =
    Repo.insert!(%Message{
      id: Ecto.UUID.generate(),
      channel_id: channel_id,
      sender_id: user.id,
      content: nil,
      ciphertext: <<7, 8, 9>>,
      mls_epoch: 1,
      inserted_at: inserted,
      updated_at: inserted
    })

  Vesper.Runtime.project_message(message)
end

for conversation_id <- Enum.take(conversation_ids, delta_conversation_message_count) do
  inserted = DateTime.add(now, 30, :second)

  message =
    Repo.insert!(%Message{
      id: Ecto.UUID.generate(),
      conversation_id: conversation_id,
      sender_id: user.id,
      content: nil,
      ciphertext: <<7, 8, 9>>,
      mls_epoch: 1,
      inserted_at: inserted,
      updated_at: inserted
    })

  Vesper.Runtime.project_message(message)
end

for channel_id <- Enum.take(channel_ids, delta_channel_mutation_count) do
  {:ok, _event} =
    Vesper.Runtime.append_scope_event("channel", channel_id, user.id, "reaction_update", %{
      message_id: Ecto.UUID.generate()
    })
end

for conversation_id <- Enum.take(conversation_ids, delta_conversation_mutation_count) do
  {:ok, _event} =
    Vesper.Runtime.append_scope_event("dm", conversation_id, user.id, "reaction_update", %{
      message_id: Ecto.UUID.generate()
    })
end

measure.("http_sync_delta", fn ->
  conn = build_conn.("GET", "/api/v1/sync?since=#{delta_token}", nil) |> Endpoint.call([])
  if conn.status != 200, do: raise("delta sync failed with #{conn.status}")
  {byte_size(conn.resp_body), Jason.decode!(conn.resp_body)}
end)

scope_since_token = SyncCursor.encode(scope_since)

scope_body =
  Jason.encode!(%{
    since: scope_since_token,
    limit: 50,
    scopes:
      Enum.map(scope_channel_ids, fn id ->
        %{
          "kind" => "channel",
          "id" => id,
          "after_seq" => Map.fetch!(scope_after_seqs, {"channel", id})
        }
      end) ++
        Enum.map(scope_conversation_ids, fn id ->
          %{
            "kind" => "dm",
            "id" => id,
            "after_seq" => Map.fetch!(scope_after_seqs, {"dm", id})
          }
        end)
  })

measure.("http_scope_sync_#{scope_sync_channel_count + scope_sync_conversation_count}", fn ->
  conn = build_conn.("POST", "/api/v1/sync/scopes", scope_body) |> Endpoint.call([])
  if conn.status != 200, do: raise("scope sync failed with #{conn.status}")
  {byte_size(conn.resp_body), Jason.decode!(conn.resp_body)}
end)

Repo.delete_all(from(position in Vesper.Chat.ChannelReadPosition, where: position.user_id == ^user.id))
Repo.delete_all(from(position in DmReadPosition, where: position.user_id == ^user.id))
Repo.delete_all(from(message in Message, where: message.sender_id == ^user.id))
Repo.delete_all(from(participant in DmParticipant, where: participant.user_id == ^user.id))
Repo.delete_all(from(conversation in DmConversation, where: conversation.id in ^conversation_ids))
Repo.delete_all(from(membership in Membership, where: membership.user_id == ^user.id and membership.server_id == ^server.id))
Repo.delete_all(from(channel in Channel, where: channel.server_id == ^server.id))

Repo.delete_all(
  from(room in Vesper.Runtime.Room,
    where: room.server_id == ^server.id or room.conversation_id in ^conversation_ids
  )
)

Repo.delete_all(from(server_row in Server, where: server_row.id == ^server.id))
Repo.delete_all(from(token in Vesper.Accounts.UserToken, where: token.user_id == ^user.id))
Repo.delete_all(from(device_row in Vesper.Accounts.Device, where: device_row.user_id == ^user.id))
Repo.delete_all(from(user_row in User, where: user_row.id == ^user.id))
