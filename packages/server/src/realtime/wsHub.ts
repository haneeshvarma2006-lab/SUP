import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PREAUTH_FRAMES,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type User,
  type WorkspaceEvent,
} from '@sup/shared';
import type { AuthService } from '../auth/authService.js';
import type { EventBus, Subscription } from '../events/eventBus.js';
import type { Repositories } from '../db/repos/index.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import { PresenceTracker } from './presence.js';
import type { SnapshotBuilder } from '../workspace/snapshot.js';

interface Connection {
  id: string;
  socket: WebSocket;
  user: User | null;
  /** Workspaces this socket is subscribed to, with the last seq it was sent. */
  subscriptions: Map<string, { lastSeq: number; subscription: Subscription }>;
  alive: boolean;
  connectedAt: number;
}

const MAX_FRAME_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30_000;
const REPLAY_BATCH = 500;

/**
 * WebSocket fan-out.
 *
 * Delivery contract, from the client's side:
 *   subscribe → `snapshot` (state + the seq it is consistent at)
 *             → `event` frames, each carrying a monotonically increasing seq.
 *
 * A client that sees a gap sends `resume{fromSeq}` and gets the missing range
 * replayed from the durable log. If the requested seq has been pruned it gets
 * `resync_required` and takes a fresh snapshot. That makes the stream
 * gap-free and correctly ordered across reconnects without the transport
 * itself having to be reliable.
 */
export class WebSocketHub {
  private readonly connections = new Map<string, Connection>();
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly events: EventBus,
    private readonly repos: Repositories,
    private readonly presence: PresenceTracker,
    private readonly snapshots: SnapshotBuilder,
    private readonly logger: Logger,
  ) {}

  attach(server: HttpServer, path = '/ws'): void {
    this.wss = new WebSocketServer({ server, path, maxPayload: MAX_FRAME_BYTES });

    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.wss.on('error', (err) => this.logger.error('websocket server error', { error: err }));

    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const connection of this.connections.values()) {
      this.teardown(connection);
      connection.socket.close(1001, 'server shutting down');
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // -- connection lifecycle -------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      user: null,
      subscriptions: new Map(),
      alive: true,
      connectedAt: Date.now(),
    };
    this.connections.set(connection.id, connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        this.send(connection, { t: 'error', code: 'bad_frame', message: 'Frame was not valid JSON' });
        return;
      }
      try {
        this.handleFrame(connection, frame);
      } catch (err) {
        this.logger.warn('frame handling failed', { type: frame?.t, error: errorMessage(err) });
        this.send(connection, {
          t: 'error',
          code: 'frame_failed',
          message: errorMessage(err),
        });
      }
    });

    socket.on('close', () => this.onClose(connection));
    socket.on('error', (err) => {
      this.logger.debug('socket error', { connectionId: connection.id, error: errorMessage(err) });
    });

    // Authentication has to arrive promptly; an unauthenticated socket is
    // otherwise a free resource for anyone who can reach the port.
    setTimeout(() => {
      if (!connection.user && this.connections.has(connection.id)) {
        this.send(connection, { t: 'error', code: 'auth_timeout', message: 'No hello frame received' });
        socket.close(4401, 'authentication timeout');
      }
    }, 10_000).unref?.();
  }

  private onClose(connection: Connection): void {
    this.teardown(connection);
    this.connections.delete(connection.id);
  }

  private teardown(connection: Connection): void {
    for (const [workspaceId, entry] of connection.subscriptions) {
      entry.subscription.unsubscribe();
      if (connection.user && this.presence.leave(workspaceId, connection.user.id, connection.id)) {
        this.events.publish(workspaceId, {
          type: 'USER_LEFT',
          actor: { type: 'user', id: connection.user.id, name: connection.user.displayName },
          payload: { userId: connection.user.id } as never,
        });
      }
    }
    connection.subscriptions.clear();
  }

  // -- frames ---------------------------------------------------------------

  private handleFrame(connection: Connection, frame: ClientFrame): void {
    if (!connection.user && !PREAUTH_FRAMES.has(frame.t)) {
      this.send(connection, { t: 'error', code: 'unauthorized', message: 'Send a hello frame first' });
      return;
    }

    switch (frame.t) {
      case 'hello':
        this.handleHello(connection, frame.token);
        return;
      case 'subscribe':
        this.handleSubscribe(connection, frame.workspaceId, frame.sinceSeq);
        return;
      case 'unsubscribe':
        this.handleUnsubscribe(connection, frame.workspaceId);
        return;
      case 'resume':
        this.handleResume(connection, frame.workspaceId, frame.fromSeq);
        return;
      case 'presence':
        this.handlePresence(connection, frame.workspaceId, frame.focus);
        return;
      case 'ping':
        this.send(connection, { t: 'pong', ts: frame.ts, serverTime: Date.now() });
        return;
    }
  }

  private handleHello(connection: Connection, token: string): void {
    const session = this.auth.authenticate(token);
    if (!session) {
      this.send(connection, { t: 'error', code: 'unauthorized', message: 'Invalid or expired token' });
      connection.socket.close(4401, 'unauthorized');
      return;
    }
    connection.user = session.user;
    this.send(connection, {
      t: 'ready',
      userId: session.user.id,
      serverTime: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  private handleSubscribe(connection: Connection, workspaceId: string, sinceSeq?: number): void {
    const user = connection.user!;

    const membership = this.repos.memberships.find(workspaceId, user.id);
    if (!membership) {
      this.send(connection, {
        t: 'error',
        code: 'forbidden',
        message: 'You are not a member of that workspace',
        workspaceId,
      });
      return;
    }

    if (connection.subscriptions.has(workspaceId)) {
      this.handleResume(connection, workspaceId, sinceSeq ?? 0);
      return;
    }

    const isFirstConnection = this.presence.join(workspaceId, user, connection.id);

    // Subscribe BEFORE taking the snapshot. Events published in between are
    // delivered and filtered by seq below, so nothing can slip through the gap.
    const subscription = this.events.subscribe(workspaceId, (event) => {
      this.deliver(connection, workspaceId, event);
    });

    const snapshot = this.snapshots.build(workspaceId, user, membership.role);
    connection.subscriptions.set(workspaceId, { lastSeq: snapshot.seq, subscription });

    this.send(connection, { t: 'snapshot', workspaceId, snapshot });

    if (isFirstConnection) {
      const entry = this.presence.entry(workspaceId, user.id);
      if (entry) {
        this.events.publish(workspaceId, {
          type: 'USER_JOINED',
          actor: { type: 'user', id: user.id, name: user.displayName },
          payload: { user: entry } as never,
        });
      }
    }
  }

  private handleUnsubscribe(connection: Connection, workspaceId: string): void {
    const entry = connection.subscriptions.get(workspaceId);
    if (!entry) return;
    entry.subscription.unsubscribe();
    connection.subscriptions.delete(workspaceId);

    const user = connection.user!;
    if (this.presence.leave(workspaceId, user.id, connection.id)) {
      this.events.publish(workspaceId, {
        type: 'USER_LEFT',
        actor: { type: 'user', id: user.id, name: user.displayName },
        payload: { userId: user.id } as never,
      });
    }
  }

  private handleResume(connection: Connection, workspaceId: string, fromSeq: number): void {
    const entry = connection.subscriptions.get(workspaceId);
    if (!entry) {
      this.send(connection, {
        t: 'error',
        code: 'not_subscribed',
        message: 'Subscribe before resuming',
        workspaceId,
      });
      return;
    }

    const oldest = this.events.oldestRetainedSeq(workspaceId);
    if (fromSeq > 0 && oldest > 0 && fromSeq < oldest - 1) {
      // The window the client needs has been pruned; patching forward would
      // silently skip changes, so force a fresh snapshot instead.
      this.send(connection, {
        t: 'resync_required',
        workspaceId,
        reason: `Events before seq ${oldest} are no longer retained`,
      });
      return;
    }

    const events = this.events.replay(workspaceId, fromSeq, REPLAY_BATCH);
    const upToSeq = events.length > 0 ? events[events.length - 1]!.seq : fromSeq;
    entry.lastSeq = Math.max(entry.lastSeq, upToSeq);
    this.send(connection, { t: 'replay', workspaceId, events, upToSeq });
  }

  private handlePresence(connection: Connection, workspaceId: string, focus: string | null): void {
    const user = connection.user!;
    if (!connection.subscriptions.has(workspaceId)) return;

    const entry = this.presence.setFocus(workspaceId, user.id, focus);
    if (!entry) return;

    this.events.publish(workspaceId, {
      type: 'USER_PRESENCE_UPDATED',
      actor: { type: 'user', id: user.id, name: user.displayName },
      payload: { user: entry } as never,
    });
  }

  // -- delivery -------------------------------------------------------------

  private deliver(connection: Connection, workspaceId: string, event: WorkspaceEvent): void {
    const entry = connection.subscriptions.get(workspaceId);
    if (!entry) return;

    // The snapshot already contains everything up to its seq; re-sending those
    // would make the client apply the same change twice.
    if (event.seq <= entry.lastSeq) return;

    entry.lastSeq = event.seq;
    this.send(connection, { t: 'event', workspaceId, event });
  }

  private send(connection: Connection, frame: ServerFrame): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch (err) {
      this.logger.debug('send failed', { connectionId: connection.id, error: errorMessage(err) });
    }
  }

  private pingAll(): void {
    for (const connection of this.connections.values()) {
      if (!connection.alive) {
        // Missed the previous heartbeat: the peer is gone even if the OS has
        // not told us yet.
        connection.socket.terminate();
        this.onClose(connection);
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        connection.socket.terminate();
        this.onClose(connection);
      }
    }
  }
}
