defmodule Mix.Tasks.Vesper.ScaleFixture do
  use Mix.Task

  @shortdoc "Create a large seeded fixture for SDK chaos soaks"

  @switches [
    active_channel_count: :integer,
    channel_count: :integer,
    label: :string,
    output_path: :string,
    password: :string,
    secondary_every: :integer,
    user_count: :integer
  ]

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("loadpaths")
    Mix.Task.run("app.config")

    {:ok, _} = Application.ensure_all_started(:crypto)
    {:ok, _} = Application.ensure_all_started(:postgrex)
    {:ok, _} = Application.ensure_all_started(:ecto_sql)
    {:ok, _} = Vesper.Repo.start_link()

    {options, _, invalid} = OptionParser.parse(args, strict: @switches)

    if invalid != [] do
      Mix.raise("invalid options: #{inspect(invalid)}")
    end

    output_path = Keyword.get(options, :output_path) || Mix.raise("--output-path is required")

    fixture =
      Vesper.Testing.ScaleFixture.build(%{
        active_channel_count: Keyword.get(options, :active_channel_count, 1),
        channel_count: Keyword.get(options, :channel_count, 1),
        label: Keyword.get(options, :label, "chaos"),
        password: Keyword.get(options, :password),
        secondary_every: Keyword.get(options, :secondary_every, 0),
        user_count: Keyword.get(options, :user_count, 1)
      })

    output_path
    |> Path.dirname()
    |> File.mkdir_p!()

    File.write!(output_path, Jason.encode_to_iodata!(fixture, pretty: true))
    Mix.shell().info("wrote scale fixture to #{output_path}")
  end
end
