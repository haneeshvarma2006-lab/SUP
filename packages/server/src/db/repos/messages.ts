import type { ActorRef, Message, MessageKind } from '@sup/shared';
import { fromJson, toJson, type Db, type DbHandle } from '../index.js';

interface MessageRow {
  id: string;
  workspace_id: string;
  channel: string;
  author: string;
  recipient: string | null;
  kind: MessageKind;
  body: string;
  mentions: string;
  task_id: string | null;
  run_id: string | null;
  parent_id: string | null;
  metadata: string;
  created_at: number;
  edited_at: number | null;
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    author: fromJson<ActorRef>(row.author, { type: 'system', id: 'system' }),
    recipient: fromJson<ActorRef | null>(row.recipient, null),
    kind: row.kind,
    body: row.body,
    mentions: fromJson<ActorRef[]>(row.mentions, []),
    taskId: row.task_id,
    runId: row.run_id,
    parentId: row.parent_id,
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

export class MessageRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(message: Message): Message {
    this.db
      .prepare(
        `INSERT INTO messages (
           id, workspace_id, channel, author, recipient, kind, body, mentions,
           task_id, run_id, parent_id, metadata, created_at, edited_at
         ) VALUES (
           @id, @workspaceId, @channel, @author, @recipient, @kind, @body, @mentions,
           @taskId, @runId, @parentId, @metadata, @createdAt, @editedAt
         )`,
      )
      .run({
        ...message,
        author: toJson(message.author),
        recipient: message.recipient ? toJson(message.recipient) : null,
        mentions: toJson(message.mentions),
        metadata: toJson(message.metadata),
      });
    return message;
  }

  byId(id: string): Message | null {
    const row = this.db.prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? mapMessage(row) : null;
  }

  /** Most recent messages across all channels, oldest-first for rendering. */
  listRecent(workspaceId: string, limit = 200): Message[] {
    return this.db
      .prepare<[string, number], MessageRow>(
        'SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(mapMessage)
      .reverse();
  }

  listChannel(workspaceId: string, channel: string, limit = 200, before?: number): Message[] {
    const rows = before
      ? this.db
          .prepare<[string, string, number, number], MessageRow>(
            `SELECT * FROM messages WHERE workspace_id = ? AND channel = ? AND created_at < ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(workspaceId, channel, before, limit)
      : this.db
          .prepare<[string, string, number], MessageRow>(
            `SELECT * FROM messages WHERE workspace_id = ? AND channel = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(workspaceId, channel, limit);
    return rows.map(mapMessage).reverse();
  }

  listForTask(taskId: string, limit = 100): Message[] {
    return this.db
      .prepare<[string, number], MessageRow>(
        'SELECT * FROM messages WHERE task_id = ? ORDER BY created_at LIMIT ?',
      )
      .all(taskId, limit)
      .map(mapMessage);
  }

  /** Messages directed at a specific actor (mention or explicit recipient). */
  listAddressedTo(workspaceId: string, actor: ActorRef, limit = 50): Message[] {
    const needle = `"id":"${actor.id}"`;
    return this.db
      .prepare<[string, string, string, number], MessageRow>(
        `SELECT * FROM messages
          WHERE workspace_id = ?
            AND (recipient LIKE '%' || ? || '%' OR mentions LIKE '%' || ? || '%')
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, needle, needle, limit)
      .map(mapMessage)
      .reverse();
  }

  /** How many messages this agent authored since `since` — feeds the rate limiter. */
  countAuthoredSince(agentId: string, since: number): number {
    const row = this.db
      .prepare<[number, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM messages
          WHERE created_at >= ? AND author LIKE '%' || ? || '%'`,
      )
      .get(since, `"id":"${agentId}"`);
    return row?.n ?? 0;
  }

  edit(id: string, body: string): Message | null {
    this.db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), id);
    return this.byId(id);
  }
}
