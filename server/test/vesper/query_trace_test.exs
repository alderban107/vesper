defmodule Vesper.QueryTraceTest do
  use Vesper.DataCase, async: false
  alias Vesper.{Chat, Servers, Runtime}

  @tag :trace
  test "trace queries for a single message send" do
    user = insert_user(%{username: "trace_user"})
    {:ok, server} = Servers.create_server(user, %{"name" => "Trace Server"})
    channel = Servers.list_channels(server.id) |> Enum.find(&(&1.type == "text"))

    # Warm the room cache
    Runtime.get_room_for_message_send(channel_id: channel.id)

    handler_id = "trace-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler_id,
      [:vesper, :repo, :query],
      fn _event, measurements, metadata, _config ->
        source = metadata[:source] || "raw"
        query = String.slice(to_string(metadata[:query] || "?"), 0, 140)

        time_us =
          Map.get(measurements, :total_time, 0) |> System.convert_time_unit(:native, :microsecond)

        IO.puts("  TRACE [#{source}] #{time_us}us: #{query}")
      end,
      nil
    )

    IO.puts("\n=== SINGLE MESSAGE SEND ===")

    {:ok, _} =
      Chat.create_message(
        %{
          channel_id: channel.id,
          sender_id: user.id,
          ciphertext: "test",
          mls_epoch: 1,
          client_nonce: "trace-1"
        },
        preload: []
      )

    IO.puts("=== END ===\n")

    :telemetry.detach(handler_id)
  end
end
