import { useMemo, useState } from 'react';
import type { ApprovalRequest, Message, Task } from '@sup/shared';
import { api } from '../api/client.js';
import {
  useAction,
  useActorLookup,
  useEscape,
  useFocusTrap,
  useTicker,
  useWorkspaceOrThrow,
} from '../state/hooks.js';
import type { WorkspaceState } from '../state/store.js';
import { Avatar, Button, ErrorNote, Icon, Spinner, relTime } from './primitives.js';

export type AttentionItem =
  | { kind: 'approval'; id: string; at: number; approval: ApprovalRequest }
  | { kind: 'question'; id: string; at: number; message: Message }
  | { kind: 'signoff'; id: string; at: number; task: Task };

/**
 * Everything currently blocked on a human, in one list.
 *
 * Three different things block a person, and before this they lived in three
 * different places — a bar, the chat stream, and a task column. Collapsing them
 * into one queue is what makes "what needs me?" answerable without hunting:
 *
 *  - an agent is suspended waiting for tool approval
 *  - an agent asked a question and is waiting on the answer
 *  - a task finished but needs sign-off before it closes
 *
 * A question counts as answered as soon as any human speaks in its channel
 * afterwards, which is the same rule the server uses to unblock the agent.
 */
export function useAttention(workspace: WorkspaceState): AttentionItem[] {
  return useMemo(() => {
    const items: AttentionItem[] = [];

    for (const approval of workspace.approvals) {
      if (approval.status !== 'pending') continue;
      items.push({ kind: 'approval', id: approval.id, at: approval.createdAt, approval });
    }

    // Latest human message per channel — anything earlier is already answered.
    const lastHumanAt = new Map<string, number>();
    for (const message of workspace.messages) {
      if (message.author.type !== 'user') continue;
      const prev = lastHumanAt.get(message.channel) ?? 0;
      if (message.createdAt > prev) lastHumanAt.set(message.channel, message.createdAt);
    }

    for (const message of workspace.messages) {
      if (message.kind !== 'question') continue;
      if ((lastHumanAt.get(message.channel) ?? 0) > message.createdAt) continue;
      items.push({ kind: 'question', id: message.id, at: message.createdAt, message });
    }

    for (const task of workspace.tasks) {
      if (task.status !== 'awaiting_approval') continue;
      items.push({ kind: 'signoff', id: task.id, at: task.updatedAt, task });
    }

    return items.sort((a, b) => b.at - a.at);
  }, [workspace.approvals, workspace.messages, workspace.tasks]);
}

export function AttentionDock({
  items,
  onClose,
  onOpenTask,
}: {
  items: AttentionItem[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  // Escape closes, like every other transient surface in the app, and focus
  // stays inside while it is open.
  useEscape(onClose);
  const trap = useFocusTrap<HTMLDivElement>();

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="dock" role="dialog" aria-modal="true" aria-label="Needs your attention" ref={trap}>
        <div className="dock__head">
          <Icon.Bell size={13} className="faint" />
          <span className="grow">
            {items.length > 0 ? `${items.length} waiting on you` : 'Nothing needs you'}
          </span>
          <Button variant="quiet" size="sm" onClick={onClose}>
            <Icon.X size={12} />
          </Button>
        </div>

        <div className="dock__body">
          {items.length === 0 ? (
            <div className="empty" style={{ padding: '26px 16px' }}>
              <div className="empty__icon">
                <Icon.Check size={17} />
              </div>
              You are all caught up. The team will surface anything it needs here.
            </div>
          ) : (
            items.map((item) => (
              <AttentionCard
                key={item.id}
                item={item}
                onOpenTask={(id) => {
                  onOpenTask(id);
                  onClose();
                }}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

function AttentionCard({
  item,
  onOpenTask,
}: {
  item: AttentionItem;
  onOpenTask: (taskId: string) => void;
}) {
  const now = useTicker(10_000);

  if (item.kind === 'approval') return <ApprovalCard approval={item.approval} now={now} />;
  if (item.kind === 'question') return <QuestionCard message={item.message} now={now} />;
  return <SignoffCard task={item.task} now={now} onOpen={() => onOpenTask(item.task.id)} />;
}

function ApprovalCard({ approval, now }: { approval: ApprovalRequest; now: number }) {
  const lookup = useActorLookup();
  const who = lookup(approval.requestedBy.id);
  const [showPayload, setShowPayload] = useState(false);

  const decide = useAction(async (allow: boolean) => {
    await api.resolveApproval(approval.id, allow);
  });

  return (
    <div className="attn" data-kind="approval">
      <div className="attn__top">
        <Icon.Lock size={12} style={{ color: 'var(--amber)' }} />
        <Avatar name={who.name} tint={who.color} emoji={who.emoji} kind={who.kind} size="xs" />
        <span style={{ color: who.color }}>{who.name}</span>
        <span className="faint" style={{ fontWeight: 460 }}>
          wants permission
        </span>
        <span className="faint grow" style={{ textAlign: 'right', fontWeight: 460 }}>
          {relTime(approval.createdAt, now)}
        </span>
      </div>

      <div className="attn__what">
        {approval.reason}
        <div className="mono faint" style={{ marginTop: 4 }}>
          {approval.action}
        </div>
      </div>

      {showPayload ? (
        <pre
          className="mono"
          style={{
            margin: '0 0 9px',
            padding: 9,
            maxHeight: 180,
            overflow: 'auto',
            background: 'var(--void)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      ) : null}

      <div className="attn__acts">
        <Button variant="ok" size="sm" onClick={() => void decide.run(true)} disabled={decide.pending}>
          <Icon.Check size={11} /> Allow
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => void decide.run(false)}
          disabled={decide.pending}
        >
          <Icon.X size={11} /> Deny
        </Button>
        <Button variant="quiet" size="sm" onClick={() => setShowPayload((v) => !v)}>
          {showPayload ? 'Hide' : 'Inspect'}
        </Button>
      </div>

      <ErrorNote>{decide.error}</ErrorNote>
    </div>
  );
}

function QuestionCard({ message, now }: { message: Message; now: number }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const who = lookup(message.author.id);
  const [answer, setAnswer] = useState('');

  const reply = useAction(async () => {
    // Replying in the question's own channel is what releases the agent — the
    // server is waiting on exactly this.
    await api.sendMessage(workspace.workspace.id, {
      body: answer.trim(),
      channel: message.channel,
      ...(message.taskId ? { taskId: message.taskId } : {}),
    });
    setAnswer('');
  });

  return (
    <div className="attn" data-kind="question">
      <div className="attn__top">
        <Icon.Info size={12} style={{ color: 'var(--amber)' }} />
        <Avatar name={who.name} tint={who.color} emoji={who.emoji} kind={who.kind} size="xs" />
        <span style={{ color: who.color }}>{who.name}</span>
        <span className="faint" style={{ fontWeight: 460 }}>
          asked you
        </span>
        <span className="faint grow" style={{ textAlign: 'right', fontWeight: 460 }}>
          {relTime(message.createdAt, now)}
        </span>
      </div>

      <div className="attn__what">{message.body}</div>

      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          value={answer}
          placeholder="Answer…"
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && answer.trim()) void reply.run();
          }}
          aria-label="Answer the agent"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void reply.run()}
          disabled={!answer.trim() || reply.pending}
        >
          {reply.pending ? <Spinner /> : <Icon.Send size={11} />}
        </Button>
      </div>

      <ErrorNote>{reply.error}</ErrorNote>
    </div>
  );
}

function SignoffCard({ task, now, onOpen }: { task: Task; now: number; onOpen: () => void }) {
  const decide = useAction(async (approved: boolean) => {
    await api.approveTask(task.id, approved);
  });

  return (
    <div className="attn" data-kind="signoff">
      <div className="attn__top">
        <Icon.Flag size={12} style={{ color: 'var(--iris-bright)' }} />
        <span style={{ color: 'var(--iris-bright)' }}>Needs sign-off</span>
        <span className="faint grow" style={{ textAlign: 'right', fontWeight: 460 }}>
          {relTime(task.updatedAt, now)}
        </span>
      </div>

      <div className="attn__what">
        <strong style={{ fontWeight: 600 }}>{task.title}</strong>
        {task.assignee ? (
          <span className="faint"> — finished by {task.assignee.name}</span>
        ) : null}
      </div>

      <div className="attn__acts">
        <Button variant="ok" size="sm" onClick={() => void decide.run(true)} disabled={decide.pending}>
          <Icon.Check size={11} /> Approve
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => void decide.run(false)}
          disabled={decide.pending}
        >
          Send back
        </Button>
        <Button variant="quiet" size="sm" onClick={onOpen}>
          Read it
        </Button>
      </div>

      <ErrorNote>{decide.error}</ErrorNote>
    </div>
  );
}
