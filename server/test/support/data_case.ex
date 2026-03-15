defmodule Vesper.DataCase do
  @moduledoc """
  Base case for tests requiring database access.
  Sets up the Ecto sandbox and provides common imports.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      alias Vesper.Repo
      import Vesper.Factory
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Vesper.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
