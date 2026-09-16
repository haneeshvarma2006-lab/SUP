import { useEffect, useMemo, useState } from 'react';
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
} from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useActorLookup, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Button, Empty, ErrorNote, Icon, Spinner, Tag, relTime, type Tone } from './primitives.js';

const SCOPE_TONE: Record<MemoryScope, Tone> = {
  project: 'iris',
  agent: 'lilac',
  episodic: 'sky',
  short_term: 'neutral',
};

const KIND_TONE: Record<MemoryKind, Tone> = {
  fact: 'neutral',
  preference: 'neutral',
  decision: 'mint',
  feedback: 'amber',
  episode: 'neutral',
  artifact: 'neutral',
  constraint: 'rose',
};

/**
 * The memory inspector.
 *
 * Memory is only trustworthy if a human can see it, correct it and delete it.
 * So everything stored is listed, every record is editable in place, and a
 * search shows the same ranking the agents get — including the component
 * scores, so a surprising retrieval can be explained rather than guessed at.
 */
export function MemoryPanel() {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(30_000);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScope | 'all'>('all');
  const [kind, setKind] = useState<MemoryKind | 'all'>('all');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  // Debounced server-side search. Ranking lives on the server, so filtering
  // locally would show a different order than the agents actually see.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      api
        .searchMemory(workspace.workspace.id, {
          q: query.trim(),
          ...(scope !== 'all' ? { scope } : {}),
          ...(kind !== 'all' ? { kind } : {}),
          limit: 40,
        })
        .then((r) => setHits(r.hits))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 240);
    return () => window.clearTimeout(timer);
  }, [query, scope, kind, workspace.workspace.id]);

  const listed = useMemo((): MemorySearchHit[] => {
    if (hits) return hits;
    return workspace.memories
      .filter((m) => (scope === 'all' ? true : m.scope === scope))
      .filter((m) => (kind === 'all' ? true : m.kind === kind))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map((record) => ({
        record,
        score: record.importance,
        breakdown: { semantic: 0, keyword: 0, importance: record.importance, recency: 0 },
      }));
  }, [hits, workspace.memories, scope, kind]);

  const canWrite = workspace.viewer.role !== 'viewer';

  return (
    <>
      <div className="pad" style={{ paddingBottom: 9, borderBottom: '1px solid var(--hairline)' }}>
        <div className="row" style={{ position: 'relative' }}>
          <Icon.Search
            size={13}
            className="faint"
            style={{ position: 'absolute', left: 10, pointerEvents: 'none' }}
          />
          <input
            className="input"
            style={{ paddingLeft: 30 }}
            placeholder="Search what the team has learned…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search memory"
          />
          {canWrite ? (
            <Button variant="ghost" size="sm" onClick={() => setComposing((v) => !v)}>
              {composing ? <Icon.X size={11} /> : <Icon.Plus size={11} />}
            </Button>
          ) : null}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <select
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value as MemoryScope | 'all')}
            aria-label="Filter by scope"
            style={{ fontSize: 12 }}
          >
            <option value="all">All scopes</option>
            {MEMORY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', '-')}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind | 'all')}
            aria-label="Filter by kind"
            style={{ fontSize: 12 }}
          >
            <option value="all">All kinds</option>
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {searching ? <Spinner /> : null}
        </div>

        {hits ? (
          <div className="faint" style={{ fontSize: 11, marginTop: 7 }}>
            Ranked by the same retrieval the agents use.
          </div>
        ) : null}
      </div>

      {composing ? <Composer onDone={() => setComposing(false)} /> : null}

      <div className="scroll">
        {listed.length === 0 ? (
          <Empty icon={<Icon.Memory size={17} />} title={query ? 'No matches' : 'Nothing learned yet'}>
            {query
              ? 'Nothing stored matches that search.'
              : 'Memory fills up as the team works, and as you correct it.'}
          </Empty>
        ) : (
          listed.map((hit) =>
            editing === hit.record.id ? (
              <Editor key={hit.record.id} record={hit.record} onDone={() => setEditing(null)} />
            ) : (
              <Item
                key={hit.record.id}
                hit={hit}
                now={now}
                canWrite={canWrite}
                agentName={hit.record.agentId ? lookup(hit.record.agentId).name : null}
                showScore={hits !== null}
                onEdit={() => setEditing(hit.record.id)}
              />
            ),
          )
        )}
      </div>
    </>
  );
}

function Item({
  hit,
  now,
  canWrite,
  agentName,
  showScore,
  onEdit,
}: {
  hit: MemorySearchHit;
  now: number;
  canWrite: boolean;
  agentName: string | null;
  showScore: boolean;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { record } = hit;

  const remove = useAction(async () => {
    await api.deleteMemory(record.id);
  });

  return (
    <div className="mem">
      <div className="mem__head">
        {record.pinned ? (
          <Icon.Pin size={11} style={{ color: 'var(--amber)' }} />
        ) : null}
        <span className="mem__title" title={record.title}>
          {record.title}
        </span>
        <Tag tone={SCOPE_TONE[record.scope]}>{record.scope.replace('_', '-')}</Tag>
        <Tag tone={KIND_TONE[record.kind]}>{record.kind}</Tag>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'block', width: '100%', textAlign: 'left' }}
        aria-expanded={open}
      >
        <div className={`mem__text${open ? '' : ' mem__text--clamp'}`}>{record.content}</div>
      </button>

      {showScore ? (
        <>
          <div className="score" title={`Relevance ${hit.score.toFixed(3)}`}>
            <i style={{ width: `${Math.min(100, Math.round(hit.score * 100))}%` }} />
          </div>
          <div className="faint mono" style={{ fontSize: 9.5, marginTop: 4 }}>
            semantic {hit.breakdown.semantic.toFixed(2)} · keyword {hit.breakdown.keyword.toFixed(2)} ·
            weight {hit.breakdown.importance.toFixed(2)} · recency {hit.breakdown.recency.toFixed(2)}
          </div>
        </>
      ) : null}

      <div className="mem__foot">
        <span className="grow trunc">
          {agentName ? `${agentName} · ` : ''}
          {record.source} · used {record.useCount}× · {relTime(record.updatedAt, now)}
        </span>
        {canWrite ? (
          <>
            <Button variant="quiet" size="sm" onClick={onEdit} ariaLabel="Edit memory">
              <Icon.Edit size={11} />
            </Button>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void remove.run()}
              disabled={remove.pending}
              ariaLabel="Delete memory"
            >
              <Icon.Trash size={11} />
            </Button>
          </>
        ) : null}
      </div>

      <ErrorNote>{remove.error}</ErrorNote>
    </div>
  );
}

function Editor({ record, onDone }: { record: MemoryRecord; onDone: () => void }) {
  const [title, setTitle] = useState(record.title);
  const [content, setContent] = useState(record.content);
  const [importance, setImportance] = useState(record.importance);
  const [pinned, setPinned] = useState(record.pinned);

  const save = useAction(async () => {
    await api.updateMemory(record.id, { title, content, importance, pinned });
    onDone();
  });

  return (
    <div className="mem" style={{ background: 'var(--raised)' }}>
      <div className="field">
        <label htmlFor={`t-${record.id}`}>Title</label>
        <input
          id={`t-${record.id}`}
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`c-${record.id}`}>Content</label>
        <textarea
          id={`c-${record.id}`}
          className="textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="row">
        <label className="row" style={{ fontSize: 11.5, gap: 6 }}>
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pinned
        </label>
        <label className="row grow" style={{ fontSize: 11.5, gap: 6, justifyContent: 'flex-end' }}>
          Weight
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span className="mono">{importance.toFixed(2)}</span>
        </label>
      </div>
      <div className="row" style={{ marginTop: 9 }}>
        <Button variant="primary" size="sm" onClick={() => void save.run()} disabled={save.pending}>
          Save
        </Button>
        <Button variant="quiet" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorNote>{save.error}</ErrorNote>
    </div>
  );
}

function Composer({ onDone }: { onDone: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<MemoryScope>('project');
  const [kind, setKind] = useState<MemoryKind>('constraint');

  const create = useAction(async () => {
    await api.createMemory(workspace.workspace.id, {
      title,
      content,
      scope,
      kind,
      pinned: kind === 'constraint',
      importance: kind === 'constraint' ? 0.9 : 0.7,
    });
    onDone();
  });

  return (
    <div
      className="pad"
      style={{ borderBottom: '1px solid var(--hairline)', background: 'var(--raised)' }}
    >
      <div className="faint" style={{ fontSize: 11, marginBottom: 9, lineHeight: 1.5 }}>
        Anything you add is retrieved into the agents' prompts on their next task.
      </div>
      <div className="field">
        <label htmlFor="nm-title">Title</label>
        <input
          id="nm-title"
          className="input"
          value={title}
          placeholder="e.g. Never recommend a tool over $200/seat"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="nm-content">Content</label>
        <textarea
          id="nm-content"
          className="textarea"
          value={content}
          placeholder="State it the way you would tell a new teammate."
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="row">
        <select
          className="select"
          value={scope}
          onChange={(e) => setScope(e.target.value as MemoryScope)}
          aria-label="Scope"
        >
          {MEMORY_SCOPES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', '-')}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          aria-label="Kind"
        >
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void create.run()}
          disabled={create.pending || !title.trim() || !content.trim()}
        >
          Remember this
        </Button>
        <Button variant="quiet" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorNote>{create.error}</ErrorNote>
    </div>
  );
}
