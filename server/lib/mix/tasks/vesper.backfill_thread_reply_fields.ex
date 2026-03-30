defmodule Mix.Tasks.Vesper.BackfillThreadReplyFields do
  use Mix.Task

  @shortdoc "Backfills thread_root_message_id and reply_to_message_id from legacy parent_message_id/is_reply"

  alias Vesper.Chat
  alias Vesper.Repo
  alias Vesper.Chat.Message

  import Ecto.Query

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    dry_run? = "--dry-run" in args

    messages =
      from(m in Message,
        where:
          is_nil(m.thread_root_message_id) or is_nil(m.reply_to_message_id),
        select: %{id: m.id, parent_message_id: m.parent_message_id, is_reply: m.is_reply}
      )
      |> Repo.all()

    {updated, skipped} =
      Enum.reduce(messages, {0, 0}, fn message, {updated_acc, skipped_acc} ->
        attrs = derive_attrs(message)

        if attrs == %{} do
          {updated_acc, skipped_acc + 1}
        else
          unless dry_run? do
            Repo.get!(Message, message.id)
            |> Message.changeset(attrs)
            |> Repo.update!()
          end

          {updated_acc + 1, skipped_acc}
        end
      end)

    Mix.shell().info("#{if(dry_run?, do: "Dry run", else: "Updated")} #{updated} messages; skipped #{skipped}.")
  end

  defp derive_attrs(%{parent_message_id: nil}), do: %{}

  defp derive_attrs(%{parent_message_id: parent_id, is_reply: true}) when is_binary(parent_id) do
    %{reply_to_message_id: parent_id}
  end

  defp derive_attrs(%{parent_message_id: parent_id, is_reply: false}) when is_binary(parent_id) do
    thread_root_id =
      case Chat.get_message(parent_id) do
        nil -> parent_id
        %{thread_root_message_id: root_id} when is_binary(root_id) -> root_id
        %{parent_message_id: legacy_parent_id, is_reply: false} when is_binary(legacy_parent_id) -> legacy_parent_id
        _ -> parent_id
      end

    %{thread_root_message_id: thread_root_id}
  end

  defp derive_attrs(_), do: %{}
end
