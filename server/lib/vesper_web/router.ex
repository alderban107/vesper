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

  pipeline :rate_limit_login do
    plug(VesperWeb.Plugs.RateLimit, action: :login)
  end

  pipeline :rate_limit_register do
    plug(VesperWeb.Plugs.RateLimit, action: :register)
  end

  pipeline :rate_limit_recover do
    plug(VesperWeb.Plugs.RateLimit, action: :recover)
  end

  pipeline :rate_limit_refresh do
    plug(VesperWeb.Plugs.RateLimit, action: :refresh)
  end

  # Health check — no auth, no pipeline
  scope "/", VesperWeb do
    get("/health", HealthController, :check)
  end

  # Public auth routes (rate-limited)
  scope "/api/v1/auth", VesperWeb do
    pipe_through(:api)

    pipe_through(:rate_limit_register)
    post("/register", AuthController, :register)
  end

  scope "/api/v1/auth", VesperWeb do
    pipe_through([:api, :rate_limit_login])

    post("/login", AuthController, :login)
  end

  scope "/api/v1/auth", VesperWeb do
    pipe_through([:api, :rate_limit_refresh])

    post("/refresh", AuthController, :refresh)
    post("/logout", AuthController, :logout)
  end

  scope "/api/v1/auth", VesperWeb do
    pipe_through([:api, :rate_limit_recover])

    post("/recover", AuthController, :recover)
    post("/recover/reset", AuthController, :recover_reset)
  end

  scope "/api/v1", VesperWeb do
    pipe_through(:api)

    get("/avatars/:user_id", AvatarController, :show)
    get("/banners/:user_id", AvatarController, :show_banner)
    get("/servers/:server_id/icon", ServerController, :show_icon)
    get("/servers/:server_id/emojis/:emoji_id/file", EmojiController, :show)
    get("/push/vapid-key", PushController, :vapid_key)
  end

  # Authenticated routes
  scope "/api/v1", VesperWeb do
    pipe_through([:api, :authenticated])

    get("/auth/me", AuthController, :me)
    get("/auth/devices", AuthController, :devices)

    put(
      "/auth/devices/current/notifications",
      AuthController,
      :update_current_device_notifications
    )

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

    post("/servers/:server_id/icon", ServerController, :upload_icon)
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
    patch("/servers/:server_id/emojis/:emoji_id", EmojiController, :update)
    delete("/servers/:server_id/emojis/:emoji_id", EmojiController, :delete)

    get("/channels/:id/messages", MessageController, :index)
    put("/channels/:id/read", MessageController, :mark_read)
    get("/channels/:id/pins", MessageController, :pins)
    get("/messages", MessageController, :batch)
    get("/messages/:id/thread", MessageController, :thread)
    get("/messages/:id", MessageController, :show)

    # Saved messages (bookmarks)
    get("/saved-messages", MessageController, :saved)
    post("/saved-messages", MessageController, :save)
    delete("/saved-messages/:message_id", MessageController, :unsave)

    # DM conversations
    resources("/conversations", ConversationController, only: [:create, :index, :show])
    get("/conversations/:conversation_id/messages", ConversationController, :messages)
    put("/conversations/:conversation_id/read", ConversationController, :mark_read)

    # Unread counts
    get("/unread", UnreadController, :index)
    get("/sync", SyncController, :index)
    get("/sync/urgent", UrgentSyncController, :index)
    post("/sync/scopes", ScopeSyncController, :create)

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
    post("/key-packages/me/consume", KeyPackageController, :consume)
    delete("/key-packages/me", KeyPackageController, :purge)
    get("/key-packages/:user_id", KeyPackageController, :show)

    # Pending welcomes
    get("/pending-welcomes/:channel_id", PendingWelcomeController, :index)
    delete("/pending-welcomes/:id", PendingWelcomeController, :delete)

    # Durable MLS control-plane event replay
    get("/mls-events/:channel_id", MlsEventController, :index)

    # Pending MLS resync requests
    get("/pending-resync-requests/:channel_id", PendingResyncRequestController, :index)
    delete("/pending-resync-requests/:id", PendingResyncRequestController, :delete)

    # MLS GroupInfo for External Commits (RFC 9420 §12.4)
    get("/group-info/:scope_id", GroupInfoController, :show)
    put("/group-info/:scope_id", GroupInfoController, :upsert)
    post("/mls-sponsored-transition/:scope_id", SponsoredTransitionController, :create)

    # Current-user room encryption topology (never enumerates other cohorts)
    get("/room-crypto-topology/:scope_id", RoomCryptoTopologyController, :show)
    put("/room-crypto-topology/:scope_id", RoomCryptoTopologyController, :update)
    post("/room-crypto-topology/:scope_id/prepare", RoomCryptoTopologyController, :prepare)
    post("/room-crypto-topology/:scope_id/cutover", RoomCryptoTopologyController, :cutover)
    post("/room-crypto-topology/:scope_id/rollback", RoomCryptoTopologyController, :rollback)

    # Signed public cohort wrapping keys
    get("/cohort-wrapping-keys/:group_id", CohortWrappingKeyController, :show)
    put("/cohort-wrapping-keys/:group_id", CohortWrappingKeyController, :upsert)

    # Fenced room data-key coordination
    get("/room-key-epochs/:scope_id/material", RoomKeyEpochController, :material)
    get("/room-key-epochs/:scope_id/active", RoomKeyEpochController, :active)
    post("/room-key-epochs/:scope_id/prepare", RoomKeyEpochController, :prepare)
    post("/room-key-epoch/:epoch_id/claim", RoomKeyEpochController, :claim)
    post("/room-key-epoch/:epoch_id/renew", RoomKeyEpochController, :renew)

    put(
      "/room-key-epoch/:epoch_id/envelopes/:cohort_id",
      RoomKeyEpochController,
      :put_envelope
    )

    post("/room-key-epoch/:epoch_id/activate", RoomKeyEpochController, :activate)
    post("/room-key-epoch/:epoch_id/stage", RoomKeyEpochController, :stage)
    post("/room-key-epoch/:epoch_id/repair", RoomKeyEpochController, :repair)

    # Bounded opaque same-user recovery packages
    get("/scope-recovery-packages/:scope_id", ScopeRecoveryPackageController, :show)
    put("/scope-recovery-packages/:scope_id", ScopeRecoveryPackageController, :upsert)

    # Pending same-user MLS history recovery
    get("/pending-history-requests/:channel_id", PendingHistoryRequestController, :index)
    delete("/pending-history-requests/:id", PendingHistoryRequestController, :delete)
    get("/pending-history-bundles/:channel_id", PendingHistoryBundleController, :index)
    delete("/pending-history-bundles/:id", PendingHistoryBundleController, :delete)
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
