/**
 * Schema migrations.
 *
 * Migrations are ordered, idempotent-by-version and applied inside a
 * transaction. `schema_migrations` records what has run so a restart against an
 * existing database is a no-op.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id    TEXT NOT NULL REFERENCES users(id),
  settings    TEXT NOT NULL,
  -- Monotonic event counter. Incremented inside the event-append transaction,
  -- which is what makes per-workspace event ordering total and gap-free.
  event_seq   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL,
  tagline             TEXT NOT NULL DEFAULT '',
  avatar_color        TEXT NOT NULL,
  avatar_emoji        TEXT NOT NULL,
  system_instructions TEXT NOT NULL,
  capabilities        TEXT NOT NULL,
  model               TEXT NOT NULL,
  temperature         REAL NOT NULL DEFAULT 0.3,
  status              TEXT NOT NULL DEFAULT 'idle',
  status_detail       TEXT NOT NULL DEFAULT '',
  current_task_id     TEXT,
  current_run_id      TEXT,
  max_concurrency     INTEGER NOT NULL DEFAULT 1,
  enabled             INTEGER NOT NULL DEFAULT 1,
  paused              INTEGER NOT NULL DEFAULT 0,
  is_orchestrator     INTEGER NOT NULL DEFAULT 0,
  stats               TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX idx_agents_workspace ON agents(workspace_id);
-- At most one orchestrator per workspace, enforced by the storage engine.
CREATE UNIQUE INDEX idx_agents_one_orchestrator
  ON agents(workspace_id) WHERE is_orchestrator = 1;

CREATE TABLE tasks (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL,
  priority                TEXT NOT NULL DEFAULT 'normal',
  created_by              TEXT NOT NULL,
  assignee                TEXT,
  parent_task_id          TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  objective_id            TEXT NOT NULL,
  depends_on              TEXT NOT NULL DEFAULT '[]',
  depth                   INTEGER NOT NULL DEFAULT 0,
  result                  TEXT,
  result_data             TEXT,
  error                   TEXT,
  artifact_ids            TEXT NOT NULL DEFAULT '[]',
  version                 INTEGER NOT NULL DEFAULT 1,
  locked_by               TEXT,
  lock_expires_at         INTEGER,
  requires_human_approval INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  started_at              INTEGER,
  completed_at            INTEGER
);
CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX idx_tasks_objective ON tasks(objective_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_assignee ON tasks(workspace_id, assignee);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  author       TEXT NOT NULL,
  recipient    TEXT,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  mentions     TEXT NOT NULL DEFAULT '[]',
  task_id      TEXT,
  run_id       TEXT,
  parent_id    TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  edited_at    INTEGER
);
CREATE INDEX idx_messages_channel ON messages(workspace_id, channel, created_at);
CREATE INDEX idx_messages_task ON messages(task_id);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  run_id       TEXT,
  task_id      TEXT,
  objective_id TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, seq)
);
CREATE INDEX idx_events_workspace_seq ON events(workspace_id, seq);
CREATE INDEX idx_events_type ON events(workspace_id, type, seq);

CREATE TABLE memories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  agent_id     TEXT,
  task_id      TEXT,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  importance   REAL NOT NULL DEFAULT 0.5,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  embedding    BLOB,
  /* Content hash, so the same fact written twice does not duplicate. */
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_memories_workspace_scope ON memories(workspace_id, scope);
CREATE INDEX idx_memories_agent ON memories(workspace_id, agent_id);
CREATE INDEX idx_memories_task ON memories(task_id);
CREATE UNIQUE INDEX idx_memories_dedupe ON memories(workspace_id, scope, content_hash);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  title,
  content,
  tags,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'text/markdown',
  size         INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL,
  task_id      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, path)
);
CREATE INDEX idx_files_workspace ON files(workspace_id);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by    TEXT NOT NULL,
  run_id          TEXT,
  task_id         TEXT,
  action          TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL DEFAULT 'null',
  status          TEXT NOT NULL DEFAULT 'pending',
  resolved_by     TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX idx_approvals_workspace_status ON approvals(workspace_id, status);

CREATE TABLE agent_runs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id      TEXT,
  status       TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  objective_id TEXT NOT NULL,
  attempt      INTEGER NOT NULL DEFAULT 1,
  /* Dedupe key: at most one live run per (task, agent, attempt). */
  idempotency_key TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  error        TEXT,
  result       TEXT,
  usage        TEXT NOT NULL,
  UNIQUE(idempotency_key)
);
CREATE INDEX idx_runs_workspace_status ON agent_runs(workspace_id, status);
CREATE INDEX idx_runs_agent ON agent_runs(agent_id, started_at);
CREATE INDEX idx_runs_task ON agent_runs(task_id);
CREATE INDEX idx_runs_objective ON agent_runs(objective_id);

CREATE TABLE run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  tool_name   TEXT,
  tool_input  TEXT,
  tool_output TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(run_id, idx)
);

CREATE TABLE delegations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  objective_id  TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id   TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  relation      TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  depth         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_delegations_objective ON delegations(objective_id);
CREATE INDEX idx_delegations_workspace ON delegations(workspace_id, created_at);

CREATE TABLE tool_audit (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       TEXT,
  agent_id     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input        TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  error        TEXT,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_tool_audit_workspace ON tool_audit(workspace_id, created_at);
CREATE INDEX idx_tool_audit_agent ON tool_audit(agent_id, created_at);
`,
  },
];
