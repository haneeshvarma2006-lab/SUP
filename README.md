# SUP

A real-time multiplayer workspace where humans and AI agents work on the same
project together. Not a chatbot with several personas — a shared room with
shared state, where an orchestrator plans work, specialists execute it, everyone
sees every change as it happens, and what the team learns persists.

```
Human: "Build a competitor analysis for my startup."

  Atlas (orchestrator)  plans, delegates, reconciles, ships
    → Vela      (researcher)  gathers sourced material
    → Orion     (analyst)     turns it into judgement
    → Juno      (reviewer)    approves or blocks
    → Lyra      (writer)      produces the artifact
```

---

## Running it

```bash
npm install
npm run seed          # creates a demo account + workspace
npm run dev           # API on :4000, web client on :5173
```

Sign in with `demo@sup.local` / `demo-password-123`, type an objective, and
watch the team work.

To see the same flow in a terminal, with the full event trace:

```bash
npm run scenario -w @sup/server
```

### Connecting a real model

**Out of the box, no language model is involved.** With no credentials the
agents run a deterministic offline policy (`HeuristicProvider`) that reads the
same prompt a real provider would — role, task, roster, upstream results — and
decides which tool to call next. That exercises every other layer for real, and
it is labelled as "Heuristic (offline, not an LLM)" in the UI, the health
endpoint and the logs so its output is never mistaken for model output.

For actual reasoning:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Nothing else changes — same agents, same tools, same orchestration.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Agents run on Claude |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter) |
| `SEARCH_PROVIDER` + `SEARCH_API_KEY` | Real web search (`tavily` or `brave`) |
| `EMBEDDINGS_PROVIDER` + `EMBEDDINGS_API_KEY` | Trained embeddings (`voyage`, `openai`) instead of the local hash |
| `AUTH_SECRET` | **Required in production.** `openssl rand -hex 32` |
| `DATABASE_PATH` | SQLite file (default `./data/sup.db`) |

Without a search provider the researcher reports the gap honestly rather than
inventing sources — see [Honesty by construction](#honesty-by-construction).

---

## Deploying

SUP is **one long-lived process**. A single Fastify listener serves the REST
API, the websocket hub (`/ws`) and the built web client on one port. Three
things follow from that, and they decide where it can run:

- the websocket hub holds connections open, so a serverless function cannot
  host it;
- `better-sqlite3` writes to a file, so the filesystem must be writable and
  persistent;
- the event log's gap-free per-workspace `seq` is allocated inside a SQLite
  `IMMEDIATE` transaction, which is correct precisely because there is exactly
  one writer.

So: a container host (Railway, Render, Fly.io) or a VM. Not Vercel, Netlify or
any other serverless target — those can host the *frontend*, but the backend has
to live somewhere that runs a real process.

### One container (recommended)

The included `Dockerfile` builds all three packages and runs the server with the
client baked in:

```bash
docker build -t sup .
docker run -p 4000:4000 \
  -v sup-data:/data \
  -e AUTH_SECRET="$(openssl rand -hex 32)" \
  -e ANTHROPIC_API_KEY=... \
  sup
```

`/data` is declared as a volume and holds the SQLite file. Mount it, or the
database is recreated empty whenever the container is replaced. `AUTH_SECRET` is
required in production — the server refuses to start without it rather than
silently shipping a known key.

Two blueprints are committed so this is one command rather than a form:

**Fly.io** — `fly.toml`:

```bash
fly launch --no-deploy --copy-config
fly volumes create sup_data --size 1
fly secrets set AUTH_SECRET="$(openssl rand -hex 32)"
fly deploy
```

**Render** — `render.yaml`, read automatically when you point Render at the
repo as a Blueprint. `AUTH_SECRET` is generated for you; set
`ANTHROPIC_API_KEY` in the dashboard.

**Railway** — detects the Dockerfile on import. Add a volume mounted at
`/data` and set `AUTH_SECRET`.

Whichever you pick, two settings are load-bearing rather than defaults worth
tweaking: a persistent disk mounted at `/data`, and exactly one always-on
instance. Scale-to-zero drops every open websocket, and a second instance is a
second SQLite writer, which breaks the event log's ordering guarantee quietly
rather than loudly. Both blueprints encode this.

All three of the above need a paid instance type, because the persistent disk
does.

### Deploying for free

This app wants three things at once — an always-on process, websockets, and a
writable disk that survives a restart — and as of 2026 almost no free tier
gives all three. Fly and Railway no longer have a free tier at all; Render's
free plan sleeps after fifteen minutes and cannot attach a disk.

Two that do work, with different trade-offs:

**Koyeb free** — easiest. One Nano service, no sleep, websockets and Docker
both supported: point it at this repo and it builds the Dockerfile. The catch
is that free instances cannot attach a volume, so `/data` is ephemeral and the
database resets on every redeploy. For a demo or a portfolio piece that is
usually fine — data survives while the service is running, and `npm run seed`
rebuilds the demo workspace.

**Oracle Cloud Always Free** — a real VM, so it is the only free option that
ticks all three boxes: always on, real block storage, no sleep. Install Docker,
then `docker build -t sup . && docker run -d -p 80:4000 -v sup-data:/data -e
AUTH_SECRET=... sup`. It costs an hour of setup, wants a card for identity
verification, and ARM capacity is frequently unavailable — the smaller AMD
shape is easier to get and is enough for this.

If you want persistence *and* a free stateless host, the real fix is to move
off SQLite onto a free managed Postgres and let any of them run the stateless
process. That is a genuine refactor — `better-sqlite3` is synchronous
throughout — not a config change.

### Frontend and backend on separate hosts

Only worth it if you specifically want the client on a CDN. The backend still
needs a container host.

Auth travels as a bearer token in `localStorage` rather than a cookie, so a
split origin needs no SameSite handling — two settings cover it:

- build the web package with `VITE_API_ORIGIN=https://your-api-host`, and
- start the server with `CORS_ORIGINS=https://your-frontend-host`.

`ws://` and `wss://` are derived from `VITE_API_ORIGIN`, so the two transports
cannot disagree about TLS. `vercel.json` in the repo root configures exactly
this deploy: it installs and builds only `@sup/shared` and `@sup/web`, so
`better-sqlite3` is never fetched or compiled, and serves `packages/web/dist`
with an SPA rewrite.

With `VITE_API_ORIGIN` unset the client uses relative paths and same-origin
websockets, which is the single-container deployment above.

## Architecture

```
packages/shared    domain types, event catalogue, wire protocol, permissions
packages/server    everything below
packages/web       React client
```

The server is layered, and each layer only knows about the one beneath it:

```
http/ realtime/        transport — Fastify routes, WebSocket fan-out
  orchestrator/        delegation, loop prevention, human-in-the-loop
    agents/            runtime (the model loop), scheduler, status
      tools/           tool registry, permission gate, sandbox
        memory/        retrieval, feedback loop
          workspace/   authoritative state mutations
            events/    the event bus
              db/      repositories, migrations
                ai/    provider abstraction
```

`app.ts` is the composition root: every service is constructed once and handed
its dependencies explicitly. Nothing reaches for a singleton, which is why a
test can stand up a complete isolated application against an in-memory database
in a few milliseconds.

Two edges in the graph are genuinely cyclic (runtime needs tool services,
orchestration needs the scheduler) and are resolved by late injection rather
than by merging the modules.

### The event log is the spine

Every meaningful change is published as a typed event with a **gap-free,
monotonically increasing sequence number per workspace**, allocated inside the
same transaction that writes it. Clients receive a snapshot stamped with a seq,
then a stream of events. A client that sees a gap asks for a replay; one that
has fallen past the retention window is told to resync.

That single mechanism gives you multiplayer, reconnection, audit and
observability at once — and it means the activity feed is the literal truth of
what the system did, not a UI-side reconstruction.

### Agent status is real

`idle → thinking → working → delegating → waiting → asking → reviewing →
completed → error`

These are written by the runtime at actual transition points — entering a model
call, dispatching a tool, blocking on a delegated child. Nothing is on a timer
and nothing is set to make the UI look busy.

### Concurrency

The part that is easy to get wrong, so it is explicit:

- **Task claiming** is an atomic compare-and-swap in SQL. Five schedulers racing
  on one ready task produce exactly one winner.
- **Duplicate execution** is prevented by a unique index on
  `(task, agent, attempt)` — enforced by the storage engine, not by application
  code that could interleave.
- **Optimistic concurrency** on task updates: the loser of a race re-reads and
  re-applies instead of clobbering.
- **Three-level concurrency bounds** (process, workspace, agent) with FIFO
  waiters, acquired in a consistent order so they cannot deadlock.
- **Slot release while blocked**: an orchestrator waiting on a child hands its
  slot back, so a delegation chain cannot deadlock against its own descendants.
- **Lock expiry and recovery**: a crashed process leaves expired locks, which
  the sweep reclaims; orphaned runs are failed at boot rather than shown as live.
- **Cancellation** is a real `AbortSignal` threaded into every model call and
  tool invocation, checked at every step boundary.

### Loop prevention

Agent-to-agent delegation passes five independent checks, because they fail
differently: self-delegation, depth limit, per-objective budget, **cycle
detection** on the delegation graph (A→B→C→A, which depth alone misses), and
duplicate-work detection. Every refusal returns a reason to the model so it can
adapt instead of retrying blindly.

Work moves between agents only through delegation. An agent mentioning another
agent in chat is just conversation — otherwise you would have an unbudgeted path
for agents to trigger each other.

### Memory

Four scopes, all durable except the first:

| Scope | What it holds |
| --- | --- |
| `short_term` | Working context for the current task; pruned aggressively |
| `project` | Facts, constraints and decisions that outlive a task |
| `agent` | Private to one agent — how *this* agent should work |
| `episodic` | What happened: past tasks, what worked, what failed |

Retrieval is hybrid: dense cosine similarity fused with BM25 keyword rank, then
adjusted by importance and recency. Both signals are kept because they fail
differently — keyword search misses paraphrase, and the default local embedding
misses synonymy.

**Nothing here retrains a model.** Memory is retrieved and injected into the
prompt at run time. That is precisely why it can be edited and deleted in the UI
and takes effect on the very next run. A rejection becomes a pinned,
high-importance, agent-scoped record that lands at the top of that agent's next
prompt. That is the entire learning mechanism, and it is not dressed up as
more.

### Tools and permissions

Every tool call passes one gate, in this order: does the tool exist → is the
agent granted it → is it within budget → does a human need to approve it →
execute with a timeout and a cancellation signal → audit, always, including
denials.

A model that hallucinates a tool it was never given gets an explicit denial it
can reason about, and the workspace sees a `TOOL_DENIED` event.

Tools are tiered `safe` / `guarded` / `dangerous`. Dangerous ones (`code_exec`,
`http_request`) genuinely suspend the agent until a human decides.

**On the sandbox, honestly:** `CodeSandbox` gives a scratch directory, a hard
timeout with SIGKILL escalation, output caps, a stripped environment and no
shell. It does **not** give kernel-level isolation — the child runs as the same
user as the server. That is why `code_exec` is `dangerous` and gated by default.
For untrusted multi-tenant use, replace that one class with a container backend;
`ToolServices` is the seam, and nothing above it changes.

---

## Honesty by construction

A multi-agent system that fabricates is worse than no system, so several choices
push against it:

- With no search provider configured, `web_search` returns an empty result set
  and tells the agent *no search was performed* — it does not return
  plausible-looking fake sources.
- The researcher's instructions treat an admitted gap as the correct output when
  there is nothing to report.
- The reviewer's checks include unsupported claims and fabricated specifics, and
  it returns `CHANGES_REQUESTED` rather than approving thin work.
- The writer is told to build only from what the team produced.
- Running out of steps without calling `return_result` is reported as a failure,
  not presented as a finished answer.
- The engine in use is displayed in the UI at all times.

You can watch this work: with no search provider, the scenario run ends with the
reviewer correctly blocking the analysis for resting on an empty research step.

---

## Testing

```bash
npm test          # 95 tests
```

Covering: the end-to-end scenario, event ordering and replay, task locking and
version conflicts, duplicate-execution prevention, semaphore and mutex
behaviour, retry and rate limiting, cancellation, delegation loop prevention
(including cycle detection), memory retrieval and the feedback loop, embedding
behaviour, FTS injection resistance, the tool permission boundary, path
traversal, SSRF guards, credential redaction, and sandbox timeout and
environment isolation.

The scenario test asserts the real thing: five agents complete work in one
workspace, dependencies are respected, delegations round-trip, statuses move
through genuine execution phases, memory is written, and an artifact reaches the
human.

The UI was verified in a real browser: sign-in, live WebSocket, the full
objective run observed through the activity feed, every panel, the agent
inspector, mention autocomplete, and **two browser clients where one receives
the other's message live** — with zero console errors and no horizontal overflow
at 400px.

---

## What is deliberately an interface, not an implementation

Per the brief — where something could not be built properly, it is a clean
abstraction rather than a fake:

- **`CodeSandbox`** — real process isolation, not real kernel isolation. Swap
  the class for a container backend.
- **SSRF protection** — blocks literal private addresses; does not catch a DNS
  name that resolves to one, which needs resolution-time hooks Node's `fetch`
  does not expose. Documented at the call site.
- **`LocalHashEmbeddingProvider`** — a smoothed lexical measure, not semantic
  understanding. `EmbeddingProvider` is the seam.
- **`HeuristicProvider`** — a rule-based policy, labelled everywhere it surfaces.
- **File storage** — text rows in SQLite; binary artifacts are out of scope for
  this tier.

---

## API

`GET /api/health` reports which AI provider, embedding provider and search
provider are actually live, so you can tell at a glance what the system is
really running on.

Full surface: auth, workspaces, members, agents (CRUD + pause/resume/stop/
mention), tasks, objectives, messages, feedback, memory (CRUD + search), files,
approvals, delegations, and the event log.

Realtime is one WebSocket at `/ws`, multiplexed over workspaces.
