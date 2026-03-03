defmodule VesperWeb.Presence do
  use Phoenix.Presence,
    otp_app: :vesper,
    pubsub_server: Vesper.PubSub
end
