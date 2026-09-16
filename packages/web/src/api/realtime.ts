import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from '@sup/shared';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeHandlers {
  onSnapshot(workspaceId: string, snapshot: WorkspaceSnapshot): void;
  onEvent(workspaceId: string, event: WorkspaceEvent): void;
  onReplay(workspaceId: string, events: WorkspaceEvent[]): void;
  onState(state: ConnectionState, detail?: string): void;
  onError(message: string): void;
  /** Called when the server says the client's position is too old to patch. */
  onResyncRequired(workspaceId: string): void;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

/**
 * WebSocket client.
 *
 * Holds the last applied `seq` per workspace. On reconnect it re-subscribes and
 * asks the server to replay from that point, so a dropped connection costs a
 * round trip rather than a missed change. An event arriving out of order — or
 * with a gap — triggers a resume rather than being applied blindly, which is
 * what keeps the local store a faithful projection of server state.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'closed';
  private readonly subscribed = new Set<string>();
  private readonly lastSeq = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  private token: string | null = null;

  constructor(private readonly handlers: RealtimeHandlers) {}

  connect(token: string): void {
    this.token = token;
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.subscribed.clear();
    this.lastSeq.clear();
    this.socket?.close(1000, 'client disconnect');
    this.socket = null;
    this.setState('closed');
  }

  subscribe(workspaceId: string): void {
    this.subscribed.add(workspaceId);
    this.send({ t: 'subscribe', workspaceId, sinceSeq: this.lastSeq.get(workspaceId) ?? 0 });
  }

  unsubscribe(workspaceId: string): void {
    this.subscribed.delete(workspaceId);
    this.lastSeq.delete(workspaceId);
    this.send({ t: 'unsubscribe', workspaceId });
  }

  setFocus(workspaceId: string, focus: string | null): void {
    this.send({ t: 'presence', workspaceId, focus });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  // -- internals -------------------------------------------------------------

  private open(): void {
    if (this.stopped || !this.token) return;

    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.send({ t: 'hello', token: this.token! });
      this.startPing();
    };

    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };

    socket.onclose = () => {
      this.clearTimers();
      if (this.stopped) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where reconnection is handled.
    };
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'ready': {
        this.setState('open');
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          this.handlers.onError(
            'This page is running an older version of the app. Reload to pick up the new one.',
          );
        }
        // Re-subscribe everything the app had open before the drop.
        for (const workspaceId of this.subscribed) {
          this.send({ t: 'subscribe', workspaceId, sinceSeq: this.lastSeq.get(workspaceId) ?? 0 });
        }
        return;
      }

      case 'snapshot': {
        this.lastSeq.set(frame.workspaceId, frame.snapshot.seq);
        this.handlers.onSnapshot(frame.workspaceId, frame.snapshot);
        return;
      }

      case 'event': {
        const expected = (this.lastSeq.get(frame.workspaceId) ?? 0) + 1;
        if (frame.event.seq < expected) return; // already applied
        if (frame.event.seq > expected) {
          // A gap means we missed something. Applying this event now would
          // leave the store permanently inconsistent, so ask for the range.
          this.send({
            t: 'resume',
            workspaceId: frame.workspaceId,
            fromSeq: this.lastSeq.get(frame.workspaceId) ?? 0,
          });
          return;
        }
        this.lastSeq.set(frame.workspaceId, frame.event.seq);
        this.handlers.onEvent(frame.workspaceId, frame.event);
        return;
      }

      case 'replay': {
        if (frame.events.length > 0) {
          this.lastSeq.set(frame.workspaceId, frame.upToSeq);
          this.handlers.onReplay(frame.workspaceId, frame.events);
        }
        return;
      }

      case 'resync_required': {
        this.lastSeq.delete(frame.workspaceId);
        this.handlers.onResyncRequired(frame.workspaceId);
        this.send({ t: 'subscribe', workspaceId: frame.workspaceId, sinceSeq: 0 });
        return;
      }

      case 'error': {
        this.handlers.onError(frame.message);
        return;
      }

      case 'pong':
        return;
    }
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    this.reconnectAttempts += 1;

    // Exponential backoff with jitter: a server restart must not be met with a
    // synchronised stampede from every open tab.
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.reconnectAttempts - 1));
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);

    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }
}
