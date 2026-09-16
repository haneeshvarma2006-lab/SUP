import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@sup/shared';
import { MAIN_CHANNEL } from '@sup/shared';
import { api } from '../api/client.js';
import { useActorLookup, useWorkspaceOrThrow } from '../state/hooks.js';
import { Markdown } from './Markdown.js';
import { Avatar, Button, ErrorNote, Icon, Spinner, Tag, clockTime } from './primitives.js';

type Lens = 'all' | 'people' | 'results';

/**
 * The room.
 *
 * Human talk, agent handoffs, delivered results and questions all share one
 * stream — separating them into tabs would destroy the thing that makes this
 * feel like a room. What keeps it readable is that each kind gets a different
 * physical form rather than a different colour of the same form:
 *
 *  - a handoff is a small pill, because it is an aside between teammates
 *  - a result is a bordered card, because it is the artifact you came for
 *  - a question is an amber card, because you are the one blocking it
 *  - system notes are one quiet line
 *
 * The lens control filters rather than reorganises, so positions stay stable.
 */
export function RoomStream({
  onOpenTask,
  shown,
  header,
}: {
  onOpenTask: (taskId: string) => void;
  shown?: boolean;
  /** Mission control, rendered above the stream but owned by the shell. */
  header?: ReactNode;
}) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();

  const [lens, setLens] = useState<Lens>('all');
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => {
    switch (lens) {
      case 'people':
        return workspace.messages.filter(
          (m) => m.author.type === 'user' || m.kind === 'question' || m.kind === 'result',
        );
      case 'results':
        return workspace.messages.filter((m) => m.kind === 'result');
      default:
        return workspace.messages;
    }
  }, [workspace.messages, lens]);

  // Follow the tail only while the reader is already at it. Yanking someone
  // back down mid-read is the classic chat-UI sin.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 140);
  }, []);

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, pinned]);

  const jump = () => {
    setPinned(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  return (
    <section className="col col--room" data-shown={shown} aria-label="Room">
      {header}

      <div className="seg" style={{ borderTop: '1px solid var(--hairline)' }}>
        {(
          [
            ['all', 'Everything'],
            ['people', 'Conversation'],
            ['results', 'Results'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="seg__btn"
            data-on={lens === key}
            onClick={() => setLens(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <FirstLight />
        ) : (
          <div className="stream" aria-live="polite" aria-relevant="additions" role="log">
            {messages.map((message, i) => (
              <Row
                key={message.id}
                message={message}
                prev={messages[i - 1]}
                lookup={lookup}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!pinned && messages.length > 0 ? (
        <button
          type="button"
          onClick={jump}
          className="btn btn--ghost btn--sm"
          style={{
            position: 'absolute',
            bottom: 96,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--raised-2)',
            boxShadow: 'var(--lift-2)',
            zIndex: 5,
          }}
        >
          <Icon.Down size={11} /> Jump to latest
        </button>
      ) : null}

      <Composer />
    </section>
  );
}

/* --------------------------------------------------------------------- row */

function Row({
  message,
  prev,
  lookup,
  onOpenTask,
}: {
  message: Message;
  prev: Message | undefined;
  lookup: ReturnType<typeof useActorLookup>;
  onOpenTask: (taskId: string) => void;
}) {
  const who = lookup(message.author.id);

  // A handoff is an aside, not a turn in the conversation — it gets its own
  // compact form and never an avatar block.
  if (message.kind === 'agent_to_agent') {
    const to = message.recipient ? lookup(message.recipient.id) : null;
    return (
      <div className="msg msg--handoff">
        <div className="msg__gutter" />
        <div className="msg__body">
          <div className="handoff">
            <Avatar name={who.name} tint={who.color} emoji={who.emoji} kind={who.kind} size="xs" />
            <Icon.Arrow size={11} className="handoff__arrow" />
            {to ? (
              <Avatar name={to.name} tint={to.color} emoji={to.emoji} kind={to.kind} size="xs" />
            ) : null}
            <span className="handoff__text" title={message.body}>
              {firstLine(message.body)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === 'system') {
    return (
      <div className="msg">
        <div className="msg__gutter" />
        <div className="msg__body">
          <div className="sysline">{message.body}</div>
        </div>
      </div>
    );
  }

  const tight =
    prev !== undefined &&
    prev.author.id === message.author.id &&
    prev.kind === message.kind &&
    message.createdAt - prev.createdAt < 150_000 &&
    message.kind !== 'result';

  return (
    <div className={`msg${tight ? ' msg--tight' : ''}`}>
      <div className="msg__gutter">
        {!tight ? (
          <Avatar name={who.name} tint={who.color} emoji={who.emoji} kind={who.kind} size="md" />
        ) : null}
      </div>

      <div className="msg__body">
        {!tight ? (
          <div className="msg__head">
            <span className="msg__who" style={{ color: who.kind === 'agent' ? who.color : undefined }}>
              {who.name}
            </span>
            {message.kind === 'feedback' ? (
              <Tag tone="lilac">
                {String((message.metadata as { verdict?: string }).verdict ?? 'feedback')}
              </Tag>
            ) : null}
            <span className="msg__when">{clockTime(message.createdAt)}</span>
          </div>
        ) : null}

        {message.kind === 'result' ? (
          <div className="result" style={{ ['--tint' as string]: who.color }}>
            <div className="result__bar" style={{ color: who.color }}>
              <Icon.Check size={11} />
              <span className="grow">
                {String((message.metadata as { summary?: string }).summary ?? 'Delivered')}
              </span>
              {message.taskId ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => onOpenTask(message.taskId!)}
                >
                  Open task
                </button>
              ) : null}
            </div>
            <div className="result__body">
              <Markdown text={message.body} />
            </div>
          </div>
        ) : message.kind === 'question' ? (
          <div className="ask">
            <div className="ask__tag">
              <Icon.Info size={11} /> Waiting on a human
            </div>
            <Markdown text={message.body} />
          </div>
        ) : message.kind === 'feedback' ? (
          <div className="feedback">
            <Markdown text={message.body} />
          </div>
        ) : (
          <Markdown text={message.body} />
        )}
      </div>
    </div>
  );
}

/**
 * The empty room.
 *
 * A new person arrives here knowing nothing, so this is the only place the
 * product gets to explain itself. It shows the actual roster — these are your
 * teammates, with their real names and roles — and then the three beats of how
 * work moves, which is the whole mental model in one read.
 */
function FirstLight() {
  const workspace = useWorkspaceOrThrow();
  const lead = workspace.agents.find((a) => a.isOrchestrator);
  const crew = workspace.agents.filter((a) => !a.isOrchestrator && a.enabled).slice(0, 5);

  return (
    <div className="firstlight">
      <div className="firstlight__faces">
        {lead ? (
          <span className="firstlight__face" title={`${lead.name} — ${lead.role}`}>
            <Avatar
              name={lead.name}
              tint={lead.avatarColor}
              emoji={lead.avatarEmoji}
              kind="agent"
              size="lg"
            />
          </span>
        ) : null}
        {crew.map((agent) => (
          <span key={agent.id} className="firstlight__face" title={`${agent.name} — ${agent.role}`}>
            <Avatar
              name={agent.name}
              tint={agent.avatarColor}
              emoji={agent.avatarEmoji}
              kind="agent"
              size="lg"
            />
          </span>
        ))}
      </div>

      <h2 className="firstlight__title">
        {workspace.agents.length > 0
          ? `${workspace.agents.length} agents are in this room with you`
          : 'Your room is empty'}
      </h2>

      <p className="firstlight__sub">
        {lead
          ? `Give ${lead.name} an objective and it will plan the work, hand each piece to the right teammate, and bring the result back here.`
          : 'Add an orchestrator agent and it will plan objectives for the rest of the team.'}
      </p>

      <ol className="firstlight__beats">
        <li>
          <span className="firstlight__n">1</span>
          <span>
            <b>State the objective</b> in the field above — one sentence is enough.
          </span>
        </li>
        <li>
          <span className="firstlight__n">2</span>
          <span>
            <b>Watch the handoffs</b> as each agent picks up its piece. Everything they do appears
            here and in the activity stream.
          </span>
        </li>
        <li>
          <span className="firstlight__n">3</span>
          <span>
            <b>Steer or correct them.</b> Feedback you give is stored in project memory and reaches
            that agent on its next task.
          </span>
        </li>
      </ol>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.replace(/\*\*/g, '').trim();
}

/* ---------------------------------------------------------------- composer */

function Composer() {
  const workspace = useWorkspaceOrThrow();
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draft at which the mention menu was dismissed. Keeping the text rather
  // than a boolean lets the menu stay shut while the person keeps typing the
  // name they already declined to complete, and come back if they delete back
  // past it.
  const [muted, setMuted] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const workspaceId = workspace.workspace.id;

  const canSend = workspace.viewer.role !== 'viewer';

  const query = useMemo(() => {
    if (muted !== null && draft.startsWith(muted)) return null;
    const match = /@([A-Za-z0-9_-]*)$/.exec(draft);
    return match ? match[1]!.toLowerCase() : null;
  }, [draft, muted]);

  const matches = useMemo(() => {
    if (query === null) return [];
    return workspace.agents
      .filter((a) => a.enabled && a.name.toLowerCase().startsWith(query))
      .slice(0, 6);
  }, [query, workspace.agents]);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(workspaceId, { body, channel: MAIN_CHANNEL });
      // Clear only once the server has it. Clearing on keypress looks snappier
      // right up until the network or the server says no, at which point what
      // the person wrote is simply gone. If they kept typing while it was in
      // flight, their newer text wins.
      setDraft((current) => (current.trim() === body ? '' : current));
      setMuted(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, sending, workspaceId]);

  const accept = useCallback((name: string) => {
    setDraft((d) => d.replace(/@([A-Za-z0-9_-]*)$/, `@${name} `));
    setCursor(0);
    setMuted(null);
    areaRef.current?.focus();
  }, []);

  // Grow with the content instead of scrolling inside two lines.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [draft]);

  if (!canSend) {
    return (
      <div className="composer">
        <div className="faint" style={{ textAlign: 'center', fontSize: 12, padding: '8px 0' }}>
          You have view-only access to this workspace.
        </div>
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="composer__box">
        {matches.length > 0 ? (
          <div className="menu" role="listbox" aria-label="Mention an agent">
            {matches.map((agent, i) => (
              <button
                key={agent.id}
                type="button"
                className="menu__item"
                data-active={i === cursor}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => accept(agent.name)}
              >
                <Avatar
                  name={agent.name}
                  tint={agent.avatarColor}
                  emoji={agent.avatarEmoji}
                  kind="agent"
                  size="sm"
                />
                <span style={{ fontWeight: 580 }}>{agent.name}</span>
                <span className="faint grow" style={{ fontSize: 11.5 }}>
                  {agent.role}
                </span>
                {i === cursor ? <Icon.Enter size={11} className="faint" /> : null}
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          placeholder="Say something, or @mention an agent to put them on it…"
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Message the room"
          onKeyDown={(e) => {
            if (matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => (c + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => (c - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                accept(matches[cursor]!.name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMuted(draft);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="composer__foot">
          <span className="composer__hint">
            <kbd>↵</kbd> send · <kbd>@</kbd> address an agent
          </span>
          {sending ? <Spinner /> : null}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={!draft.trim() || sending}
          >
            <Icon.Send size={11} /> Send
          </Button>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
