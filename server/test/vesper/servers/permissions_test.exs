defmodule Vesper.Servers.PermissionsTest do
  use Vesper.DataCase, async: true

  alias Vesper.Servers
  alias Vesper.Servers.Permissions

  # ---------------------------------------------------------------------------
  # has_permission?/2
  # ---------------------------------------------------------------------------
  describe "has_permission?/2" do
    test "returns true when the exact bit is set" do
      assert Permissions.has_permission?(Permissions.send_messages(), Permissions.send_messages())
    end

    test "returns true when multiple bits are set and the required one is among them" do
      import Bitwise
      combined = Permissions.send_messages() ||| Permissions.kick_members()
      assert Permissions.has_permission?(combined, Permissions.kick_members())
    end

    test "returns false when the bit is not set" do
      refute Permissions.has_permission?(Permissions.send_messages(), Permissions.ban_members())
    end

    test "returns false for zero permissions without administrator" do
      refute Permissions.has_permission?(0, Permissions.send_messages())
    end

    test "administrator bypasses any check" do
      assert Permissions.has_permission?(Permissions.administrator(), Permissions.manage_server())
      assert Permissions.has_permission?(Permissions.administrator(), Permissions.ban_members())
    end
  end

  # ---------------------------------------------------------------------------
  # compute_permissions/1
  # ---------------------------------------------------------------------------
  describe "compute_permissions/1" do
    test "ORs permissions from multiple roles" do
      import Bitwise

      roles = [
        %{permissions: Permissions.send_messages()},
        %{permissions: Permissions.kick_members()}
      ]

      result = Permissions.compute_permissions(roles)
      assert result == (Permissions.send_messages() ||| Permissions.kick_members())
    end

    test "returns 0 for an empty list" do
      assert Permissions.compute_permissions([]) == 0
    end

    test "returns the single role's value for a one-element list" do
      assert Permissions.compute_permissions([%{permissions: Permissions.manage_channels()}]) ==
               Permissions.manage_channels()
    end

    test "duplicate bits do not change the result" do
      roles = [
        %{permissions: Permissions.send_messages()},
        %{permissions: Permissions.send_messages()}
      ]

      assert Permissions.compute_permissions(roles) == Permissions.send_messages()
    end
  end

  # ---------------------------------------------------------------------------
  # Servers.get_user_permissions/2
  # ---------------------------------------------------------------------------
  describe "Servers.get_user_permissions/2" do
    test "owner receives administrator permission" do
      owner = insert_user()
      server = insert_server(owner)
      _membership = insert_membership(owner, server, %{role: "owner"})

      perms = Servers.get_user_permissions(owner.id, server.id)
      assert Permissions.has_permission?(perms, Permissions.administrator())
    end

    test "member with custom roles accumulates those role permissions" do
      import Bitwise
      owner = insert_user()
      server = insert_server(owner)

      member = insert_user()
      membership = insert_membership(member, server, %{role: "member"})

      role_a = insert_role(server, %{permissions: Permissions.kick_members()})
      role_b = insert_role(server, %{permissions: Permissions.manage_channels()})
      insert_member_role(membership, role_a)
      insert_member_role(membership, role_b)

      perms = Servers.get_user_permissions(member.id, server.id)

      # Base "member" permission is send_messages, plus the two custom roles
      expected =
        Permissions.send_messages() |||
          Permissions.kick_members() |||
          Permissions.manage_channels()

      assert perms == expected
    end

    test "non-member gets 0" do
      owner = insert_user()
      server = insert_server(owner)
      outsider = insert_user()

      assert Servers.get_user_permissions(outsider.id, server.id) == 0
    end
  end
end
