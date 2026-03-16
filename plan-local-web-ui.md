# Plan: Local Web Chat UI

## Goal

First-time user runs `npm run dev:ui`, opens `http://localhost:3000` in a browser, and can immediately chat with all 10 agents — no Discord, no Slack, no PermaShip account required.

## Architecture

```
Browser (localhost:3000)
    ↕ WebSocket + REST
Local Fastify Server (port 3000)
    ↕
Existing Agent Engine (processWebhookMessage flow)
    ↕
LocalCommunicationAdapter (captures outbound messages, pushes to WS)
```

The key insight: the agent engine already processes `UnifiedMessage` objects and emits responses through `CommunicationAdapter`. We implement a local adapter that captures outbound messages and pushes them to connected WebSocket clients instead of calling an external API.

---

## New Files

```
src/local/
  server.ts              # Fastify server on port 3000 (serves UI + API + WS)
  communication-adapter.ts  # LocalCommunicationAdapter (captures messages, emits to WS)
  tenant-resolver.ts     # SingleTenantResolver (hardcoded local org, no activation)
  setup.ts               # Auto-creates local org, workspace link, default channel
  index.ts               # Entry point: initAdapters with local adapters, start server

ui/
  index.html             # Single-page chat UI
  app.js                 # Vanilla JS (no build step) — WS client, message rendering
  style.css              # Minimal chat styling
```

## Implementation Steps

### Step 1: LocalCommunicationAdapter

```typescript
// src/local/communication-adapter.ts
import type { CommunicationAdapter, OutboundMessage, SendMessageOptions } from '../adapters/interfaces/communication-adapter.js';
import { EventEmitter } from 'events';

export const localBus = new EventEmitter();

export class LocalCommunicationAdapter implements CommunicationAdapter {
  async sendMessage(message: OutboundMessage, options: SendMessageOptions) {
    const id = crypto.randomUUID();
    // Emit to any connected WebSocket clients
    localBus.emit('message', {
      id,
      content: message.content,
      embed_title: message.embed_title,
      embed_description: message.embed_description,
      components: message.components,
      channel_id: options.channel_id ?? options.thread_id,
      timestamp: new Date().toISOString(),
    });
    return { success: true, message_id: id };
  }

  async addReaction(channelId: string, messageId: string, emoji: string) {
    localBus.emit('reaction', { channelId, messageId, emoji });
    return { success: true };
  }

  async renameThread(threadId: string, newName: string) {
    localBus.emit('thread_rename', { threadId, newName });
    return { success: true };
  }
}
```

### Step 2: SingleTenantResolver

No activation flow. One hardcoded local org.

```typescript
// src/local/tenant-resolver.ts
import type { TenantResolver, WorkspaceContext } from '../adapters/interfaces/tenant-resolver.js';

const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000001';
const LOCAL_WORKSPACE_ID = 'local';

export class SingleTenantResolver implements TenantResolver {
  async getContext(): Promise<WorkspaceContext> {
    return {
      orgId: LOCAL_ORG_ID,
      orgName: 'Local',
      platform: 'discord',        // platform field is required but irrelevant locally
      workspaceId: LOCAL_WORKSPACE_ID,
      internalChannelId: 'local:general',
    };
  }
  async getOrgName() { return 'Local'; }
  shouldPrompt() { return false; }
  async linkWorkspace() { return { success: true }; }
  async setInternalChannel() { return { success: true }; }
  async activateWorkspace() { return { success: false, error: 'Not supported in local mode' }; }
}
```

### Step 3: Local Fastify Server

```
GET  /                          → serves ui/index.html
GET  /app.js, /style.css       → static files from ui/
WS   /ws                        → WebSocket (pushes agent messages to browser)
POST /api/chat/send             → accepts { content, authorName? }
GET  /api/chat/history          → returns recent messages from conversation_history
GET  /api/agents                → returns agent list (id, title, summary)
POST /api/chat/approve/:id      → approve a pending action
POST /api/chat/reject/:id       → reject a pending action
```

The `/api/chat/send` handler constructs a `UnifiedMessage` and calls `processWebhookMessage()`:

```typescript
server.post('/api/chat/send', async (request) => {
  const { content, authorName } = request.body as { content: string; authorName?: string };

  const unified: UnifiedMessage = {
    id: `local-${Date.now()}`,
    content,
    channelId: 'local:general',
    workspaceId: 'local',
    authorId: 'local-user',
    authorName: authorName ?? 'You',
    isThread: false,
    platform: 'discord',
    orgId: LOCAL_ORG_ID,
  };

  // Fire-and-forget (same pattern as webhook handler)
  processWebhookMessage(unified).catch(err => logger.error({ err }, 'Local message processing failed'));

  return { success: true, messageId: unified.id };
});
```

WebSocket handler listens to `localBus` and forwards to connected clients.

### Step 4: Browser UI

Minimal single-page app (no React, no build step):

- Chat message list with agent avatars/names
- Input box at bottom
- Messages appear in real-time via WebSocket
- Agent messages rendered with markdown (use a lightweight MD renderer like `marked`)
- Proposal approval cards with approve/reject buttons (rendered from `components` in outbound messages)
- Agent roster sidebar showing all 10 agents

### Step 5: Local Setup / Bootstrap

On first run, auto-seed the database:
- Create workspace link for `local` workspace → local org
- Set `local:general` as internal channel
- Run agent initialization

### Step 6: Entry Point

```typescript
// src/local/index.ts
import 'dotenv/config';
import { initAdapters } from '../adapters/registry.js';
import { LocalCommunicationAdapter } from './communication-adapter.js';
import { SingleTenantResolver } from './tenant-resolver.js';
// ... other adapters (reuse Gemini LLM, local DB, etc.)

initAdapters({
  communicationAdapter: new LocalCommunicationAdapter(),
  tenantResolver: new SingleTenantResolver(),
  // ... rest same as production
});

// Run migrations, init agents, start local server
```

Add to `package.json`:
```json
"dev:ui": "tsx src/local/index.ts"
```

---

## What We Reuse vs. Build New

| Component | Reuse | Build New |
|-----------|-------|-----------|
| Agent engine (executor, router, strategy) | Yes | — |
| Conversation storage (DB) | Yes | — |
| Nexus scheduler, idle timer | Yes | — |
| Knowledge service, embeddings | Yes | — |
| CommunicationAdapter | — | LocalCommunicationAdapter |
| TenantResolver | — | SingleTenantResolver |
| LLM Provider (Gemini) | Yes | — |
| Web server | — | Local Fastify + WS |
| Browser UI | — | HTML/JS/CSS |
| Ticket tracker | Reuse local DB path | — |

## Open Questions

- Should the local UI support multiple "channels" or just one `general` channel?
- Should proposal approval buttons work in the UI, or require CLI?
- Should the local mode include idle timer / Nexus scheduler, or keep it chat-only?
- Hot reload: should the UI auto-reconnect on server restart?

## Estimated Scope

- ~400 lines backend (server, adapters, setup)
- ~300 lines frontend (HTML/JS/CSS)
- 0 new dependencies if we use Fastify's built-in static file serving and a lightweight WS library
