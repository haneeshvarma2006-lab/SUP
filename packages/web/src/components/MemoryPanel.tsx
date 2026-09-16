import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Badge, Empty, ErrorText, PanelHeader, Spinner, relativeTime } from './primitives.js';

const SCOPE_TONE: Record<MemoryScope, 'accent' | 'info' | 'violet' | 'neutral'> = {
  project: 'accent',
  agent: 'violet',
  episodic: 'info',
  short_term: 'neutral',
};

const KIND_TONE: Record<MemoryKind, 'ok' | 'warn' | 'danger' | 'neutral' | 'violet'> = {
  fact: 'neutral',
  preference: 'neutral',
  decision: 'ok',
  feedback: 'warn',
  episode: 'neutral',
  artifact: 'neutral',
  constraint: 'danger',
};

/**
 * The memory inspector.
 *
 * Memory is only trustworthy if a human can see it, correct it and delete it —
 * so everything stored is listed here, with the retrieval score that put it
 * near the top, and every record is editable in place.
 */
export function MemoryPanel() {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(30_000);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScope | 'all'>('all');
  const [kind, setKind] = useState<MemoryKind | 'all'>('all');
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Debounced server-side search: the ranking (semantic + keyword + importance
  // + recency) lives on the server, so filtering locally would show a different
  // order than the agents actually see.
  useEffect(() => {
    if (!query.trim()) {
      setSearchHits(null);
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
        .then((response) => setSearchHits(response.hits))
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [query, scope, kind, workspace.workspace.id]);

  const listed = useMemo((): MemorySearchHit[] => {
    if (searchHits) return searchHits;
    return workspace.memories
      .filter((m) => (scope === 'all' ? true : m.scope === scope))
      .filter((m) => (kind === 'all' ? true : m.kind === kind))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map((record) => ({
        record,
        score: record.importance,
        breakdown: { semantic: 0, keyword: 0, importance: record.importance, recency: 0 },
      }));
  }, [searchHits, workspace.memories, scope, kind]);

  const canWrite = workspace.viewer.role !== 'viewer';

  return (
    <>
      <PanelHeader title="Memory" count={workspace.memories.length}>
        {canWrite ? (
          <button type="button" className="btn ghost sm" onClick={() => setComposing((v) => !v)}>
            {composing ? 'Cancel' : '+ Add'}
          </button>
        ) : null}
      </PanelHeader>

      <div className="pad" style={{ paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <input
          className="input"
          placeholder="Search what the team has learned…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search memory"
        />
        <div className="row" style={{ marginTop: 8 }}>
          <select
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value as MemoryScope | 'all')}
            aria-label="Filter by scope"
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
        {searchHits ? (
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
            Ranked by the same retrieval the agents use.
          </div>
        ) : null}
      </div>

      {composing ? <MemoryComposer onDone={() => setComposing(false)} /> : null}

      <div className="column-scroll">
        {listed.length === 0 ? (
          <Empty icon="⌾">
            {query ? 'Nothing matched that search.' : 'Nothing learned yet. Memory fills up as the team works.'}
          </Empty>
        ) : (
          listed.map((hit) =>
            editingId === hit.record.id ? (
              <MemoryEditor
                key={hit.record.id}
                record={hit.record}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <MemoryItem
                key={hit.record.id}
                hit={hit}
                now={now}
                canWrite={canWrite}
                agentName={hit.record.agentId ? lookup(hit.record.agentId).name : null}
                showScore={searchHits !== null}
                onEdit={() => setEditingId(hit.record.id)}
              />
            ),
          )
        )}
      </div>
    </>
  );
}

function MemoryItem({
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
  const [expanded, setExpanded] = useState(false);
  const { record } = hit;

  const remove = useAction(async () => {
    await api.deleteMemory(record.id);
  });

  return (
    <div className="memory-item">
      <div className="memory-head">
        {record.pinned ? <span title="Pinned by a human">📌</span> : null}
        <span className="memory-title" title={record.title}>
          {record.title}
        </span>
        <Badge tone={SCOPE_TONE[record.scope]}>{record.scope.replace('_', '-')}</Badge>
        <Badge tone={KIND_TONE[record.kind]}>{record.kind}</Badge>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{ display: 'block', width: '100%', textAlign: 'left' }}
      >
        <div className={`memory-content${expanded ? '' : ' clamped'}`}>{record.content}</div>
      </button>

      {showScore ? (
        <>
          <div className="relevance-bar" title={`Relevance ${hit.score.toFixed(3)}`}>
            <div
              className="relevance-fill"
              style={{ width: `${Math.min(100, Math.round(hit.score * 100))}%` }}
            />
          </div>
          <div className="dim mono" style={{ fontSize: 10, marginTop: 3 }}>
            semantic {hit.breakdown.semantic.toFixed(2)} · keyword {hit.breakdown.keyword.toFixed(2)} ·
            importance {hit.breakdown.importance.toFixed(2)} · recency {hit.breakdown.recency.toFixed(2)}
          </div>
        </>
      ) : null}

      <div className="row" style={{ marginTop: 7, fontSize: 11 }}>
        <span className="dim">
          {agentName ? `${agentName} · ` : ''}
          {record.source} · used {record.useCount}× · {relativeTime(record.updatedAt, now)}
        </span>
        {canWrite ? (
          <span className="row" style={{ marginLeft: 'auto', gap: 4 }}>
            <button type="button" className="btn ghost sm" onClick={onEdit}>
              Edit
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void remove.run()}
              disabled={remove.pending}
            >
              Delete
            </button>
          </span>
        ) : null}
      </div>
      <ErrorText>{remove.error}</ErrorText>
    </div>
  );
}

function MemoryEditor({ record, onDone }: { record: MemoryRecord; onDone: () => void }) {
  const [title, setTitle] = useState(record.title);
  const [content, setContent] = useState(record.content);
  const [importance, setImportance] = useState(record.importance);
  const [pinned, setPinned] = useState(record.pinned);

  const save = useAction(async () => {
    await api.updateMemory(record.id, { title, content, importance, pinned });
    onDone();
  });

  return (
    <div className="memory-item" style={{ background: 'var(--surface-2)' }}>
      <div className="field">
        <label htmlFor={`m-title-${record.id}`}>Title</label>
        <input
          id={`m-title-${record.id}`}
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`m-content-${record.id}`}>Content</label>
        <textarea
          id={`m-content-${record.id}`}
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
        <label className="row" style={{ fontSize: 11.5, gap: 6, marginLeft: 'auto' }}>
          Importance
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
          />
          <span className="mono">{importance.toFixed(2)}</span>
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => void save.run()}
          disabled={save.pending}
        >
          Save
        </button>
        <button type="button" className="btn ghost sm" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorText>{save.error}</ErrorText>
    </div>
  );
}

function MemoryComposer({ onDone }: { onDone: () => void }) {
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

  const submit = useCallback(() => {
    if (!title.trim() || !content.trim()) return;
    void create.run();
  }, [title, content, create]);

  return (
    <div className="pad" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
      <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
        Anything you add here is retrieved into the agents' prompts on their next task.
      </div>
      <div className="field">
        <label htmlFor="new-memory-title">Title</label>
        <input
          id="new-memory-title"
          className="input"
          value={title}
          placeholder="e.g. Never recommend a tool over $200/seat"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="new-memory-content">Content</label>
        <textarea
          id="new-memory-content"
          className="textarea"
          value={content}
          placeholder="State it the way you would tell a new teammate."
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="row">
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as MemoryScope)}>
          {MEMORY_SCOPES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', '-')}
            </option>
          ))}
        </select>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn primary sm"
          onClick={submit}
          disabled={create.pending || !title.trim() || !content.trim()}
        >
          Remember this
        </button>
        <button type="button" className="btn ghost sm" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorText>{create.error}</ErrorText>
    </div>
  );
}
