# Code Standards

> See also: [System Architecture](system-architecture.md) | [Testing Guide](testing-guide.md) | [Codebase Summary](codebase-summary.md)

## Elixir Conventions

### Context Pattern

Business logic lives in context modules (`Accounts`, `Chat`, `Servers`, `Encryption`, `Runtime`, `Sync`, `Voice`). Controllers and channels call context functions — they never query the database directly.

```elixir
# Controller calls context
def create(conn, params) do
  case Servers.create_server(conn.assigns.current_user, params) do
    {:ok, server} -> json(conn, server_json(server))
    {:error, changeset} -> json(conn, format_errors(changeset))
  end
end
```

### Return Conventions

All context functions return tagged tuples:
- `{:ok, result}` on success
- `{:error, reason}` on failure (atom or changeset)
- `Repo.transaction` wraps multi-step operations — a failure anywhere rolls back everything

### Ecto Query Composition

Build queries incrementally with `from/2` and pipe through filter functions:

```elixir
query =
  from(m in Message,
    left_join: event in RoomEvent,
    on: event.message_id == m.id,
    join: sender in assoc(m, :sender),
    where: m.channel_id == ^channel_id,
    order_by: [desc: m.inserted_at, desc: m.id],
    limit: ^limit,
    select_merge: %{room_seq: event.room_seq},
    preload: [sender: sender]
  )

query = apply_before_cursor(query, before)
query = apply_after_cursor(query, after_cursor)
Repo.all(query)
```

**Preload optimization**: Join sender inline with `join: sender in assoc(m, :sender)` + `preload: [sender: sender]` instead of separate preload query. Other associations (attachments, reactions) use standard preload when needed.

### Raw SQL for Performance

Use `Repo.query/2` with CTEs when multiple DB operations must be atomic in a single round-trip:

```elixir
sql = """
WITH seq AS (
  UPDATE rooms SET current_seq = current_seq + 1, updated_at = $2
  WHERE id = $1 RETURNING current_seq
)
INSERT INTO room_events (id, room_id, room_seq, ...)
SELECT $3, $1, seq.current_seq, ... FROM seq
RETURNING id, room_seq
"""
Repo.query(sql, params)
```

Use `GREATEST()` instead of conditional UPDATE for race-free writes:

```elixir
Repo.query!("""
  UPDATE rooms SET
    last_message_seq = GREATEST(COALESCE(last_message_seq, 0), $1),
    last_message_id = CASE WHEN COALESCE(last_message_seq, 0) < $1 THEN $2 ELSE last_message_id END
  WHERE id = $3
""", [room_seq, message_id, room_id])
```

### GenServer + ETS Cache Pattern

For hot-path reads, use ETS with GenServer-managed invalidation:

```elixir
# Public read: direct ETS, no GenServer involvement
def get(user_id, server_id) do
  case :ets.lookup(@table, {user_id, server_id}) do
    [{_, permissions}] -> permissions
    [] ->
      # Cache miss: query DB directly from caller process (no GenServer bottleneck)
      permissions = compute_from_db(user_id, server_id)
      :ets.insert(@table, {{user_id, server_id}, permissions})
      GenServer.cast(__MODULE__, {:ensure_subscribed, server_id})
      permissions
  end
end

# GenServer handles invalidation only
def handle_info({:permissions_changed, server_id}, state) do
  :ets.match_delete(@table, {{:_, server_id}, :_})
  {:noreply, state}
end
```

### PubSub Invalidation

Broadcast cache invalidation via Phoenix.PubSub. Subscribe lazily on first cache miss:

```elixir
# On role change:
Phoenix.PubSub.broadcast(Vesper.PubSub, "server:permissions:#{server_id}", {:permissions_changed, server_id})

# Cache GenServer subscribes:
Phoenix.PubSub.subscribe(Vesper.PubSub, "server:permissions:#{server_id}")
```

### Permission Bitfields

Permissions are integers with bitwise operations:

```elixir
import Bitwise

@send_messages    1
@manage_messages  2
@administrator    16384

def has_permission?(user_perms, required) do
  (user_perms &&& @administrator) != 0 or (user_perms &&& required) != 0
end

def compute_permissions(roles) do
  Enum.reduce(roles, 0, fn role, acc -> acc ||| role.permissions end)
end
```

## TypeScript / React Conventions

### Zustand Store Pattern

One store per domain. Stores are independent — cross-store communication via function imports:

```typescript
export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  sendMessage: async (channelId, content) => {
    const message = await sdk.chat.sendMessage(channelId, content)
    set(state => ({ messages: { ...state.messages, [message.id]: message } }))
  }
}))
```

### Component Organization

```
components/
├── auth/       # Login, register, device trust, recovery
├── chat/       # Message list, input, reactions, pins
│   └── message/  # Individual message rendering
├── dm/         # DM sidebar, conversation list
├── layout/     # Sidebar, header, main grid
├── server/     # Server/channel management
├── settings/   # User preferences
├── ui/         # Reusable primitives (Button, Modal, etc.)
└── voice/      # Call UI, participants, controls
```

### SDK Entry Points

Modular imports — use only what you need:

```typescript
import { createVesperClient } from '@vesper/sdk'
import { createVesperAuthClient } from '@vesper/sdk/auth'
import { MemoryStorage } from '@vesper/sdk/storage'
```

## Testing Patterns

### Test Case Templates

| Template | Use For | Async? |
|----------|---------|--------|
| `DataCase` | Context functions (DB) | Yes |
| `ConnCase` | Controller HTTP tests | Yes |
| `ChannelCase` | WebSocket channel tests | No |

### Factory Module

Direct struct insertion with sane defaults:

```elixir
user = insert_user(%{username: "test_user"})
device = insert_device(user, %{trust_state: "trusted"})
server = Servers.create_server(user, %{"name" => "Test"})
role = insert_role(server, %{permissions: Permissions.send_messages()})
```

### Concurrent Testing

Use `Task.async` + `Ecto.Adapters.SQL.Sandbox.allow` for race condition tests:

```elixir
parent = self()
Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, task_pid)
```

## Git Workflow

### Commit Format

```
<type>: <description>

Types: feat, fix, refactor, docs, test, chore, perf, style
```

### Pre-commit Hooks

Configured via `.githooks/pre-commit` (run `scripts/setup-git-hooks.sh`):
1. `mix compile --warnings-as-errors`
2. `mix test` (full suite)
3. `npm run check:web` (TypeScript + Vite build)

### Branch Naming

`<type>/<description>` — e.g., `feat/websocket-media-relay`, `fix/mls-e2e-handshake`

## Error Handling

### Logger Levels

| Level | Use |
|-------|-----|
| `Logger.debug` | Detailed tracing, variable values |
| `Logger.info` | Normal operations, startup |
| `Logger.warning` | Handled but unexpected situations |
| `Logger.error` | Failures that need attention |

### Controller Error Responses

Consistent JSON shape: `%{error: "message"}` or `%{errors: %{field: "message"}}` from changeset formatting.

### Transaction Rollback

Use `Repo.rollback/1` inside `Repo.transaction/1` for early exit:

```elixir
Repo.transaction(fn ->
  case step_one() do
    {:ok, result} -> result
    {:error, reason} -> Repo.rollback(reason)
  end
end)
```
