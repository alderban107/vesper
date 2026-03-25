# Hypothesis Queue — vesper-full-server (1M Scale)

| Rank | ID | Hypothesis | Confidence | Location | Source Persona |
|------|----|-----------|-----------|----------|----------------|
| 1 | H-01 | Sync fan-out creates O(N) DB writes per message, causing write bottleneck at >10K users per server | HIGH | lib/vesper/sync.ex, lib/vesper/runtime.ex | Performance Engineer (confirmed 3/8, scaled) |
| 2 | H-02 | Login/register endpoints with no rate limiting enable Argon2 CPU exhaustion DoS at scale | HIGH | lib/vesper_web/router.ex, lib/vesper_web/controllers/auth_controller.ex | Security Analyst (confirmed 7/8) |
| 3 | H-03 | Voice Room GenServer mailbox becomes RTP forwarding bottleneck at 25 participants, causing audio latency | HIGH | lib/vesper/voice/room.ex | Performance Engineer + Elixir/OTP Specialist (confirmed 3/8) |
| 4 | H-04 | Critical paths (auth, permissions, sync, encryption) lack test coverage, increasing regression risk during scale refactors | HIGH | test/ directory | Devil's Advocate (confirmed 8/8) |
| 5 | H-05 | PermissionsCache cold-start serializes through single GenServer, causing thundering herd after deployment | MEDIUM | lib/vesper/servers/permissions_cache.ex | Performance Engineer |
| 6 | H-06 | Recovery key verification has no rate limit, enabling offline brute-force | HIGH | lib/vesper_web/controllers/auth_controller.ex:192 | Security Analyst (confirmed 5/8) |
| 7 | H-07 | Unlinked attachments accessible to any authenticated user via UUID guessing | MEDIUM | lib/vesper_web/controllers/attachment_controller.ex:97 | Architecture Reviewer (confirmed 5/8) |
| 8 | H-08 | Local filesystem storage prevents horizontal scaling of file operations | MEDIUM | lib/vesper/chat/file_storage.ex:7 | Architecture Reviewer |
| 9 | H-09 | Compromised client can inflate GroupInfo epoch, blocking legitimate publishes | MEDIUM | lib/vesper/encryption.ex (publish_group_info) | Cryptography Reviewer (confirmed 3/8) |
| 10 | H-10 | Voice room crash (restart: :temporary) loses all participants with no recovery | MEDIUM | lib/vesper/voice/room.ex:2 | Reliability Engineer (confirmed 3/8) |
