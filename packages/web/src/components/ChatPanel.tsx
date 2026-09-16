import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@sup/shared';
import { MAIN_CHANNEL } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useActorLookup, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Markdown } from './Markdown.js';
import {
  AgentAvatar,
  Avatar,
  Badge,
  Empty,
  ErrorText,
  Spinner,
  clockTime,
  relativeTime,
} from './primitives.js';

/**
 * The shared conversation.
 *
 * Human chat, agent-to-agent handoffs, results, questions and feedback all land
 * in the same stream, visually distinguished rather than separated — the point
 * of the product is that everyone can see what everyone else is doing.
 */
export function ChatPanel({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const tick = useTicker(30_000);

  const [filter, setFilter] = useState<'all' | 'humans' | 'agents' | 'results'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const messages = useMemo(() => {
    const all = workspace.messages;
    switch (filter) {
      case 'humans':
        return all.filter((m) => m.author.type === 'user' || m.kind === 'question');
      case 'agents':
        return all.filter((m) => m.kind === 'agent_to_agent' || m.author.type === 'agent');
      case 'results':
        return all.filter((m) => m.kind === 'result');
      default:
        return all;
    }
  }, [workspace.messages, filter]);

  // Follow the bottom only while the reader is already there. Yanking someone
  // back down while they are reading history is the classic chat-UI sin.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div className="column" style={{ background: 'var(--bg)' }}>
      <div className="tabs">
        {(
          [
            ['all', 'Everything'],
            ['humans', 'Human'],
            ['agents', 'Agent traffic'],
            ['results', 'Results'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab${filter === key ? ' active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="column-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <Empty icon="💬">
            Nothing here yet. Give the team an objective below, or @mention an agent directly.
          </Empty>
        ) : (
          <div className="chat-stream">
            {messages.map((message, index) => (
              <MessageRow
                key={message.id}
                message={message}
                previous={messages[index - 1]}
                lookup={lookup}
                now={tick}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        )}
      </div>

      <Composer />
    </div>
  );
}

function MessageRow({
  message,
  previous,
  lookup,
  now,
  onOpenTask,
}: {
  message: Message;
  previous: Message | undefined;
  lookup: ReturnType<typeof useActorLookup>;
  now: number;
  onOpenTask: (taskId: string) => void;
}) {
  const author = lookup(message.author.id);

  // Consecutive messages from the same author within two minutes are grouped,
  // which is what stops an agent's tool chatter from dominating the column.
  const grouped =
    previous !== undefined &&
    previous.author.id === message.author.id &&
    previous.kind === message.kind &&
    message.createdAt - previous.createdAt < 120_000;

  return (
    <div className={`message kind-${message.kind}${grouped ? ' grouped' : ''}`}>
      <div className="message-gutter">
        {!grouped ? (
          <Avatar
            name={author.name}
            color={author.color}
            emoji={author.emoji}
            kind={author.kind}
            size="md"
          />
        ) : null}
      </div>

      <div className="message-body">
        {!grouped ? (
          <div className="message-head">
            <span className="message-author" style={{ color: author.color }}>
              {author.name}
            </span>
            {message.kind === 'agent_to_agent' && message.recipient ? (
              <Badge tone="accent">→ {lookup(message.recipient.id).name}</Badge>
            ) : null}
            {message.kind === 'result' ? <Badge tone="ok">result</Badge> : null}
            {message.kind === 'question' ? <Badge tone="warn">needs an answer</Badge> : null}
            {message.kind === 'feedback' ? (
              <Badge tone="violet">
                {String((message.metadata as { verdict?: string }).verdict ?? 'feedback')}
              </Badge>
            ) : null}
            <span className="message-time" title={new Date(message.createdAt).toLocaleString()}>
              {clockTime(message.createdAt)}
            </span>
          </div>
        ) : null}

        <Markdown text={message.body} />

        {message.taskId ? (
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginTop: 6 }}
            onClick={() => onOpenTask(message.taskId!)}
          >
            Open task
          </button>
        ) : null}

        {grouped ? (
          <span className="message-time dim" style={{ display: 'none' }}>
            {relativeTime(message.createdAt, now)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The composer.
 *
 * Two modes in one box: plain chat, and `@mention` which hands the message to
 * that agent as an instruction. The mention autocomplete is driven off the live
 * roster, so an agent added seconds ago is immediately addressable.
 */
function Composer() {
  const workspace = useWorkspaceOrThrow();
  const [draft, setDraft] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = workspace.viewer.role !== 'viewer';

  const mentionQuery = useMemo(() => {
    const match = /@([A-Za-z0-9_-]*)$/.exec(draft);
    return match ? match[1]!.toLowerCase() : null;
  }, [draft]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return workspace.agents
      .filter((a) => a.enabled && a.name.toLowerCase().startsWith(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, workspace.agents]);

  const send = useAction(async (body: string) => {
    await api.sendMessage(workspace.workspace.id, { body, channel: MAIN_CHANNEL });
  });

  const submit = useCallback(() => {
    const body = draft.trim();
    if (!body || send.pending) return;
    setDraft('');
    void send.run(body);
  }, [draft, send]);

  const applyMention = useCallback(
    (name: string) => {
      setDraft((current) => current.replace(/@([A-Za-z0-9_-]*)$/, `@${name} `));
      setMenuIndex(0);
      textareaRef.current?.focus();
    },
    [],
  );

  // Auto-grow the textarea rather than scrolling inside a two-line box.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [draft]);

  if (!canSend) {
    return (
      <div className="composer">
        <div className="dim" style={{ fontSize: 12.5, textAlign: 'center', padding: '6px 0' }}>
          You have view-only access to this workspace.
        </div>
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="composer-box" style={{ position: 'relative' }}>
        {candidates.length > 0 ? (
          <div className="mention-menu" role="listbox">
            {candidates.map((agent, i) => (
              <button
                key={agent.id}
                type="button"
                className={`mention-option${i === menuIndex ? ' active' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => applyMention(agent.name)}
                role="option"
                aria-selected={i === menuIndex}
              >
                <AgentAvatar agent={agent} size="sm" />
                <span style={{ fontWeight: 600 }}>{agent.name}</span>
                <span className="dim" style={{ fontSize: 12 }}>
                  {agent.role}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          placeholder="Message the room, or @mention an agent to put them on it…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (candidates.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % candidates.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                applyMention(candidates[menuIndex]!.name);
                return;
              }
              if (e.key === 'Escape') {
                setDraft((d) => `${d} `);
                return;
              }
            }
            // Enter sends; Shift+Enter is a newline. Standard for chat, and the
            // hint below says so.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer-actions">
          <span className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>@</kbd> to address an agent
          </span>
          {send.pending ? <Spinner /> : null}
          <button
            type="button"
            className="btn primary sm"
            onClick={submit}
            disabled={!draft.trim() || send.pending}
          >
            Send
          </button>
        </div>
      </div>
      <ErrorText>{send.error}</ErrorText>
    </div>
  );
}
