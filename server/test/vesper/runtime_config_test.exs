defmodule Vesper.RuntimeConfigTest do
  use ExUnit.Case, async: true

  alias Vesper.RuntimeConfig

  @fallback String.duplicate("fallback-secret-", 3)

  test "blank optional secrets use the strong fallback" do
    assert RuntimeConfig.secret_or_fallback!("JWT_SECRET", nil, @fallback, 32) == @fallback
    assert RuntimeConfig.secret_or_fallback!("JWT_SECRET", "", @fallback, 32) == @fallback
    assert RuntimeConfig.secret_or_fallback!("JWT_SECRET", "   ", @fallback, 32) == @fallback
  end

  test "explicit strong secrets are preserved" do
    configured = String.duplicate("configured-secret-", 2)

    assert RuntimeConfig.secret_or_fallback!("JWT_SECRET", configured, @fallback, 32) ==
             configured
  end

  test "weak configured values and weak fallbacks fail closed" do
    assert_raise RuntimeError, ~r/JWT_SECRET must contain at least 32 bytes/, fn ->
      RuntimeConfig.secret_or_fallback!("JWT_SECRET", "too-short", @fallback, 32)
    end

    assert_raise RuntimeError, ~r/JWT_SECRET must contain at least 32 bytes/, fn ->
      RuntimeConfig.secret_or_fallback!("JWT_SECRET", nil, "weak-fallback", 32)
    end
  end
end
