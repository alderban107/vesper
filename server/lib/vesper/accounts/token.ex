defmodule Vesper.Accounts.Token do
  use Joken.Config

  @access_token_ttl 15 * 60

  def access_token_ttl, do: @access_token_ttl

  @impl true
  def token_config do
    default_claims(default_exp: @access_token_ttl)
    |> add_claim("type", fn -> "access" end, &(&1 == "access"))
  end

  def generate_access_token(user, device) do
    claims = %{
      "sub" => user.id,
      "device_id" => device.id,
      "device_trust_state" => device.trust_state,
      "username" => user.username,
      "type" => "access"
    }

    generate_and_sign(claims)
  end

  def verify_access_token(token) do
    verify_and_validate(token)
  end
end
