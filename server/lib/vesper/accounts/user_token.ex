defmodule Vesper.Accounts.UserToken do
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @refresh_token_validity_days 30

  schema "user_tokens" do
    field :token, :binary
    field :context, :string
    field :device_name, :string
    field :sent_to, :string

    belongs_to :user, Vesper.Accounts.User

    field :inserted_at, :utc_datetime
  end

  def refresh_token_validity_days, do: @refresh_token_validity_days

  def build_refresh_token(user) do
    token = :crypto.strong_rand_bytes(32)

    %__MODULE__{
      token: token,
      context: "refresh",
      user_id: user.id,
      inserted_at: DateTime.utc_now() |> DateTime.truncate(:second)
    }
  end

  def valid_refresh_token_query(token) do
    import Ecto.Query

    from t in __MODULE__,
      where: t.token == ^token and t.context == "refresh",
      where: t.inserted_at > ago(^@refresh_token_validity_days, "day")
  end
end
