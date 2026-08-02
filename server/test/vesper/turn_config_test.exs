defmodule Vesper.TurnConfigTest do
  use ExUnit.Case, async: true

  @required_denials ~w(
    0.0.0.0-0.255.255.255
    10.0.0.0-10.255.255.255
    100.64.0.0-100.127.255.255
    127.0.0.0-127.255.255.255
    169.254.0.0-169.254.255.255
    172.16.0.0-172.31.255.255
    192.0.0.0-192.0.0.255
    192.0.2.0-192.0.2.255
    192.88.99.0-192.88.99.255
    192.168.0.0-192.168.255.255
    198.18.0.0-198.19.255.255
    198.51.100.0-198.51.100.255
    203.0.113.0-203.0.113.255
    224.0.0.0-255.255.255.255
    ::1
    ::ffff:0:0-::ffff:ffff:ffff
    64:ff9b::-64:ff9b::ffff:ffff
    64:ff9b:1::-64:ff9b:1:ffff:ffff:ffff:ffff:ffff
    100::-100::ffff:ffff:ffff:ffff
    100:0:0:1::-100:0:0:1:ffff:ffff:ffff:ffff
    2001::-2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff
    2001:db8::-2001:db8:ffff:ffff:ffff:ffff:ffff:ffff
    2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    3fff::-3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff
    5f00::-5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    fec0::-feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
  )

  @required_allowances ~w(
    2001:1::1
    2001:1::2
    2001:1::3
    2001:3::-2001:3:ffff:ffff:ffff:ffff:ffff:ffff
    2001:4:112::-2001:4:112:ffff:ffff:ffff:ffff:ffff
    2001:20::-2001:2f:ffff:ffff:ffff:ffff:ffff:ffff
    2001:30::-2001:3f:ffff:ffff:ffff:ffff:ffff:ffff
  )

  test "bundled TURN policy denies private and special-use peer destinations" do
    config =
      __DIR__
      |> Path.join("../../../turnserver.conf")
      |> Path.expand()
      |> File.read!()

    lines = String.split(config, "\n")

    denials =
      lines
      |> Enum.filter(&String.starts_with?(&1, "denied-peer-ip="))
      |> Enum.map(&String.replace_prefix(&1, "denied-peer-ip=", ""))

    allowances =
      lines
      |> Enum.filter(&String.starts_with?(&1, "allowed-peer-ip="))
      |> Enum.map(&String.replace_prefix(&1, "allowed-peer-ip=", ""))

    assert length(denials) == MapSet.size(MapSet.new(denials)),
           "TURN peer-denial ranges must not be duplicated"

    assert length(allowances) == MapSet.size(MapSet.new(allowances)),
           "TURN peer-allowance ranges must not be duplicated"

    assert MapSet.subset?(MapSet.new(@required_denials), MapSet.new(denials))
    assert MapSet.new(allowances) == MapSet.new(@required_allowances)
    assert "no-multicast-peers" in lines
    assert "no-tls" in lines
    assert "no-dtls" in lines
    refute "cli" in lines
    refute "no-cli" in lines
    refute String.contains?(config, "allow-loopback-peers\n")
    refute "no-loopback-peers" in lines
  end
end
