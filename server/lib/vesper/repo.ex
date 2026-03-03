defmodule Vesper.Repo do
  use Ecto.Repo,
    otp_app: :vesper,
    adapter: Ecto.Adapters.Postgres
end
