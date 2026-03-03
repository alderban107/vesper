defmodule Vesper.Servers.Permissions do
  @moduledoc """
  Permission bitfield constants and helpers for role-based access control.
  """

  import Bitwise

  # Permission bits
  @send_messages     1
  @manage_messages   2
  @manage_channels   4
  @manage_server     8
  @kick_members      16
  @ban_members       32
  @invite_members    64
  @manage_roles      128
  @manage_voice      256
  @mention_everyone  512
  @administrator     16384

  @all_permissions %{
    send_messages: @send_messages,
    manage_messages: @manage_messages,
    manage_channels: @manage_channels,
    manage_server: @manage_server,
    kick_members: @kick_members,
    ban_members: @ban_members,
    invite_members: @invite_members,
    manage_roles: @manage_roles,
    manage_voice: @manage_voice,
    mention_everyone: @mention_everyone,
    administrator: @administrator
  }

  def all_permissions, do: @all_permissions

  def send_messages, do: @send_messages
  def manage_messages, do: @manage_messages
  def manage_channels, do: @manage_channels
  def manage_server, do: @manage_server
  def kick_members, do: @kick_members
  def ban_members, do: @ban_members
  def invite_members, do: @invite_members
  def manage_roles, do: @manage_roles
  def manage_voice, do: @manage_voice
  def mention_everyone, do: @mention_everyone
  def administrator, do: @administrator

  @doc "Check if a combined permission bitfield includes a specific permission."
  def has_permission?(user_permissions, required) do
    # Administrator bypasses all checks
    (user_permissions &&& @administrator) != 0 ||
      (user_permissions &&& required) != 0
  end

  @doc "Combine permissions from multiple roles into a single bitfield."
  def compute_permissions(roles) do
    Enum.reduce(roles, 0, fn role, acc -> acc ||| role.permissions end)
  end
end
