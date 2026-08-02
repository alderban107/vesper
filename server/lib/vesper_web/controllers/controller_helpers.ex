defmodule VesperWeb.ControllerHelpers do
  @moduledoc """
  Shared utility functions for controllers.
  """

  @doc """
  Parses a string or integer value as an integer, returning `default` on failure.
  """
  def parse_int(nil, default), do: default

  def parse_int(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {n, _} -> n
      :error -> default
    end
  end

  def parse_int(value, _default) when is_integer(value), do: value
  def parse_int(_, default), do: default

  @doc """
  Parses a string, integer, or boolean value as a boolean, returning `default`
  on failure.
  """
  def parse_bool(nil, default), do: default
  def parse_bool(value, _default) when is_boolean(value), do: value
  def parse_bool(value, _default) when is_integer(value), do: value != 0

  def parse_bool(value, default) when is_binary(value) do
    case String.downcase(String.trim(value)) do
      value when value in ["1", "true", "yes", "on"] -> true
      value when value in ["0", "false", "no", "off"] -> false
      _ -> default
    end
  end

  def parse_bool(_, default), do: default

  @doc """
  Authorizes an MLS group without conflating its protocol ID with the room used
  for access control. Cohort groups resolve through the active user assignment;
  legacy single groups resolve directly to their channel or conversation.
  """
  def authorize_mls_scope(user_id, scope_id) do
    alias Vesper.Chat
    alias Vesper.Encryption
    alias Vesper.Servers

    case Encryption.get_active_user_cohort(scope_id, user_id) do
      {cohort, topology, room} ->
        {:ok,
         %{
           group_id: scope_id,
           room_id: room.id,
           cohort_id: cohort.id,
           topology_generation: topology.generation,
           channel_id: room.channel_id,
           conversation_id: room.conversation_id
         }}

      nil ->
        with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
          cond do
            Servers.get_channel_if_member(uuid, user_id) != nil ->
              {:ok, %{group_id: uuid, channel_id: uuid, conversation_id: nil}}

            Chat.get_conversation(uuid) == nil ->
              {:error, :not_found}

            Chat.user_is_participant?(user_id, uuid) ->
              {:ok, %{group_id: uuid, channel_id: nil, conversation_id: uuid}}

            true ->
              {:error, :forbidden}
          end
        else
          :error -> {:error, :invalid_scope}
        end
    end
  end

  @doc """
  Authorizes history recovery and binds it to the requester's current
  application-membership tenure. The MLS membership generation remains a
  separate device-level freshness fence.
  """
  def authorize_history_scope(user_id, scope_id) do
    alias Vesper.Encryption

    with {:ok, scope} <- authorize_mls_scope(user_id, scope_id),
         {:ok, application_membership, room} <- history_authorization_source(user_id, scope),
         authorization when not is_nil(authorization) <-
           Encryption.get_room_history_authorization(room.id, user_id),
         true <- authorization.authorization_generation == application_membership.id do
      {:ok,
       Map.merge(scope, %{
         authorization_generation: authorization.authorization_generation,
         authorized_after_room_seq: authorization.authorized_after_room_seq
       })}
    else
      nil -> {:error, :forbidden}
      false -> {:error, :forbidden}
      error -> error
    end
  end

  @doc """
  Authorizes read-only public MLS material. Active cohort snapshots are readable
  by every room member, while mutations remain restricted to cohort members.
  """
  def authorize_mls_public_read(user_id, scope_id) do
    alias Vesper.Encryption

    case Encryption.get_active_cohort_context(scope_id) do
      {cohort, topology, room} ->
        logical_scope_id = room.channel_id || room.conversation_id

        with {:ok, _authorized_room} <- authorize_room_scope(user_id, logical_scope_id) do
          {:ok,
           %{
             group_id: cohort.group_id,
             room_id: room.id,
             cohort_id: cohort.id,
             topology_generation: topology.generation,
             channel_id: room.channel_id,
             conversation_id: room.conversation_id
           }}
        end

      nil ->
        authorize_mls_scope(user_id, scope_id)
    end
  end

  @doc """
  Authorizes a logical channel or conversation and returns its canonical room.
  """
  def authorize_room_scope(user_id, scope_id) do
    alias Vesper.Chat
    alias Vesper.Runtime
    alias Vesper.Servers

    with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
      case Servers.get_channel(uuid) do
        nil ->
          case Chat.get_conversation(uuid) do
            nil ->
              {:error, :not_found}

            _conversation ->
              if Chat.user_is_participant?(user_id, uuid) do
                case Runtime.get_room_for_conversation(uuid) do
                  nil -> {:error, :not_found}
                  room -> {:ok, room}
                end
              else
                {:error, :forbidden}
              end
          end

        _channel ->
          with channel when not is_nil(channel) <- Servers.get_channel_if_member(uuid, user_id),
               room when not is_nil(room) <- Runtime.get_room_for_channel(channel.id) do
            {:ok, room}
          else
            nil -> {:error, :forbidden}
          end
      end
    else
      :error -> {:error, :invalid_scope}
    end
  end

  defp history_authorization_source(user_id, %{conversation_id: conversation_id})
       when is_binary(conversation_id) do
    alias Vesper.Chat
    alias Vesper.Runtime

    with participant when not is_nil(participant) <-
           Chat.get_participant(user_id, conversation_id),
         room when not is_nil(room) <- Runtime.get_room_for_conversation(conversation_id) do
      {:ok, participant, room}
    else
      nil -> {:error, :forbidden}
    end
  end

  defp history_authorization_source(user_id, %{channel_id: channel_id})
       when is_binary(channel_id) do
    alias Vesper.Chat
    alias Vesper.Runtime
    alias Vesper.Servers

    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        {:error, :not_found}

      is_binary(channel.server_id) ->
        with membership when not is_nil(membership) <-
               Servers.get_channel_membership(user_id, channel),
             room when not is_nil(room) <- Runtime.get_room_for_channel(channel_id) do
          {:ok, membership, room}
        else
          nil -> {:error, :forbidden}
        end

      true ->
        case Chat.get_dm_context_for_channel(channel_id) do
          {conversation_id, _participant_ids} ->
            history_authorization_source(user_id, %{conversation_id: conversation_id})

          nil ->
            with membership when not is_nil(membership) <-
                   Servers.get_channel_membership(user_id, channel),
                 room when not is_nil(room) <- Runtime.get_room_for_channel(channel_id) do
              {:ok, membership, room}
            else
              nil -> {:error, :forbidden}
            end
        end
    end
  end

  defp history_authorization_source(_user_id, _scope), do: {:error, :not_found}

  @doc """
  Formats Ecto changeset errors into a plain map of field => message strings,
  suitable for returning in JSON API responses.
  """
  def format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
