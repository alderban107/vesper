defmodule VesperWeb.Router do
  use VesperWeb, :router

  pipeline :api do
    plug(:accepts, ["json"])
  end

  pipeline :authenticated do
    plug(VesperWeb.Plugs.Auth)
  end

  pipeline :trusted_device do
    plug(VesperWeb.Plugs.RequireTrustedDevice)
  end

  # Health check — no auth, no pipeline
  scope "/", VesperWeb do
    get("/health", HealthController, :check)
  end

  # Public auth routes
  scope "/api/v1/auth", VesperWeb do
    pipe_through(:api)

    post("/register", AuthController, :register)
    post("/login", AuthController, :login)
    post("/refresh", AuthController, :refresh)
    post("/logout", AuthController, :logout)
    post("/recover", AuthController, :recover)
    post("/recover/reset", AuthController, :recover_reset)
  end

  scope "/api/v1", VesperWeb do
    pipe_through(:api)

    get("/avatars/:user_id", AvatarController, :show)
    get("/banners/:user_id", AvatarController, :show_banner)
    get("/servers/:server_id/emojis/:emoji_id/file", EmojiController, :show)
  end

  # Authenticated routes
  scope "/api/v1", VesperWeb do
    pipe_through([:api, :authenticated])

    get("/auth/me", AuthController, :me)
    get("/auth/devices", AuthController, :devices)

    post(
      "/auth/devices/approve-with-recovery",
      AuthController,
      :approve_current_device_with_recovery
    )

    put("/auth/profile", AuthController, :update_profile)
    put("/auth/password", AuthController, :change_password)
    post("/auth/avatar", AvatarController, :create)
    post("/auth/banner", AvatarController, :create_banner)

    resources "/servers", ServerController, except: [:new, :edit] do
      resources("/channels", ChannelController, except: [:new, :edit])
    end

    post("/servers/join", ServerController, :join)

    # Invite code (permission-gated, rotates every 24h)
    get("/servers/:server_id/invite-code", ServerController, :invite_code)

    # Invites
    get("/servers/:server_id/invites", ServerController, :list_invites)
    post("/servers/:server_id/invites", ServerController, :create_invite)
    delete("/servers/:server_id/invites/:invite_id", ServerController, :revoke_invite)
    delete("/servers/:server_id/leave", ServerController, :leave)
    get("/servers/:server_id/members", ServerController, :members)
    delete("/servers/:server_id/members/:user_id", ServerController, :kick)
    post("/servers/:server_id/members/:user_id/ban", ServerController, :ban)
    delete("/servers/:server_id/members/:user_id/ban", ServerController, :unban)
    get("/servers/:server_id/bans", ServerController, :bans)
    get("/servers/:server_id/audit-logs", ServerController, :audit_logs)

    # Roles
    get("/servers/:server_id/roles", ServerController, :list_roles)
    post("/servers/:server_id/roles", ServerController, :create_role)
    put("/servers/:server_id/roles/:role_id", ServerController, :update_role)
    delete("/servers/:server_id/roles/:role_id", ServerController, :delete_role)
    put("/servers/:server_id/members/:user_id/roles", ServerController, :update_member_roles)

    # Emojis
    get("/servers/:server_id/emojis", EmojiController, :index)
    post("/servers/:server_id/emojis", EmojiController, :create)
    delete("/servers/:server_id/emojis/:emoji_id", EmojiController, :delete)

    get("/channels/:id/messages", MessageController, :index)
    put("/channels/:id/read", MessageController, :mark_read)
    get("/channels/:id/pins", MessageController, :pins)
    get("/messages/:id/thread", MessageController, :thread)

    # DM conversations
    resources("/conversations", ConversationController, only: [:create, :index, :show])
    get("/conversations/:conversation_id/messages", ConversationController, :messages)
    put("/conversations/:conversation_id/read", ConversationController, :mark_read)

    # Unread counts
    get("/unread", UnreadController, :index)

    # Attachments
    post("/attachments", AttachmentController, :create)
    get("/attachments/:id", AttachmentController, :show)

    # User search
    get("/users/search", UserController, :search)

    # Voice/WebRTC runtime config
    get("/voice/config", VoiceController, :config)
  end

  scope "/api/v1", VesperWeb do
    pipe_through([:api, :authenticated, :trusted_device])

    post("/auth/devices/:id/approve", AuthController, :approve_device)
    post("/auth/devices/:id/revoke", AuthController, :revoke_device)

    # Encrypted search index snapshot sync
    get("/search-index", SearchIndexController, :show)
    put("/search-index", SearchIndexController, :upsert)
    delete("/search-index", SearchIndexController, :delete)

    # Key package directory
    post("/key-packages", KeyPackageController, :create)
    get("/key-packages/me/count", KeyPackageController, :count)
    get("/key-packages/:user_id", KeyPackageController, :show)

    # Pending welcomes
    get("/pending-welcomes/:channel_id", PendingWelcomeController, :index)
    delete("/pending-welcomes/:id", PendingWelcomeController, :delete)

    # Pending MLS resync requests
    get("/pending-resync-requests/:channel_id", PendingResyncRequestController, :index)
    delete("/pending-resync-requests/:id", PendingResyncRequestController, :delete)
  end

  # Enable LiveDashboard in development
  if Application.compile_env(:vesper, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through([:fetch_session, :protect_from_forgery])

      live_dashboard("/dashboard", metrics: VesperWeb.Telemetry)
      forward("/mailbox", Plug.Swoosh.MailboxPreview)
    end
  end
end
