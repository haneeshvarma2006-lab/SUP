import {
  ID_PREFIXES,
  newId,
  truncate,
  type ActorRef,
  type FeedbackVerdict,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
} from '@sup/shared';
import { cosineSimilarity, type EmbeddingProvider } from '../ai/embeddings.js';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import type { Logger } from '../util/logger.js';
import { badRequest, errorMessage, notFound } from '../util/errors.js';

export interface WriteMemoryInput {
  workspaceId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  content: string;
  createdBy: ActorRef;
  agentId?: string | null;
  taskId?: string | null;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  source?: string;
}

export interface SearchMemoryInput {
  workspaceId: string;
  query: string;
  scopes?: MemoryScope[];
  kinds?: MemoryKind[];
  /** The agent doing the search; scopes agent-private memory to it. */
  agentId?: string | null;
  taskId?: string | null;
  limit?: number;
  /** Below this combined score a hit is dropped rather than padded in. */
  minScore?: number;
}

/** Relative weight of each retrieval signal. Tuned so no one signal dominates. */
const WEIGHTS = {
  semantic: 0.45,
  keyword: 0.3,
  importance: 0.15,
  recency: 0.1,
} as const;

const RECENCY_HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 14;
const SHORT_TERM_KEEP = 200;

/**
 * Memory: storage, retrieval and the feedback loop.
 *
 * Four scopes, all durable except `short_term`:
 *  - short_term — working context for the current task; pruned aggressively.
 *  - project    — facts, constraints and decisions that outlive a task.
 *  - agent      — private to one agent; how *this* agent should work.
 *  - episodic   — what happened: past tasks, what worked, what failed.
 *
 * Nothing here retrains a model. Memory is retrieved at run time and injected
 * into the prompt, which is why it can be edited and deleted and takes effect
 * on the very next run.
 */
export class MemoryService {
  constructor(
    private readonly repos: Repositories,
    private readonly embeddings: EmbeddingProvider,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  // -- writes ---------------------------------------------------------------

  async write(input: WriteMemoryInput): Promise<MemoryRecord> {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw badRequest('Memory needs a title');
    if (!content) throw badRequest('Memory needs content');
    if (content.length > 20_000) throw badRequest('Memory content is too large (20k char limit)');

    const now = Date.now();
    const record: MemoryRecord = {
      id: newId(ID_PREFIXES.memory, now),
      workspaceId: input.workspaceId,
      scope: input.scope,
      kind: input.kind,
      agentId: input.scope === 'agent' ? (input.agentId ?? null) : (input.agentId ?? null),
      taskId: input.taskId ?? null,
      title,
      content,
      tags: normaliseTags(input.tags ?? []),
      importance: clamp01(input.importance ?? defaultImportance(input.kind)),
      pinned: input.pinned ?? false,
      createdBy: input.createdBy,
      source: input.source ?? 'manual',
      useCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const vector = await this.embedSafely(`${title}\n${content}`);
    const { record: stored, created } = this.repos.memories.upsert(record, vector);

    this.events.publish(input.workspaceId, {
      type: created ? 'MEMORY_CREATED' : 'MEMORY_UPDATED',
      actor: input.createdBy,
      payload: { record: stored } as never,
      taskId: stored.taskId,
    });

    if (input.scope === 'short_term') {
      this.repos.memories.pruneShortTerm(input.workspaceId, SHORT_TERM_KEEP);
    }

    return stored;
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'title' | 'content' | 'tags' | 'kind' | 'scope' | 'importance' | 'pinned'>>,
    actor: ActorRef,
  ): Promise<MemoryRecord> {
    const existing = this.repos.memories.byId(id);
    if (!existing) throw notFound('Memory');

    const contentChanged =
      (patch.title !== undefined && patch.title !== existing.title) ||
      (patch.content !== undefined && patch.content !== existing.content);

    const vector = contentChanged
      ? await this.embedSafely(`${patch.title ?? existing.title}\n${patch.content ?? existing.content}`)
      : undefined;

    const updated = this.repos.memories.update(
      id,
      { ...patch, tags: patch.tags ? normaliseTags(patch.tags) : undefined },
      vector,
    );
    if (!updated) throw notFound('Memory');

    this.events.publish(updated.workspaceId, {
      type: 'MEMORY_UPDATED',
      actor,
      payload: { record: updated } as never,
    });
    return updated;
  }

  delete(id: string, actor: ActorRef): void {
    const existing = this.repos.memories.byId(id);
    if (!existing) throw notFound('Memory');
    this.repos.memories.delete(id);
    this.events.publish(existing.workspaceId, {
      type: 'MEMORY_DELETED',
      actor,
      payload: { memoryId: id } as never,
    });
  }

  // -- retrieval ------------------------------------------------------------

  /**
   * Hybrid retrieval: dense cosine similarity fused with BM25 keyword rank,
   * then adjusted by importance and recency.
   *
   * Both lexical and dense signals are kept because they fail differently —
   * keyword search misses paraphrase, and the default local embedding misses
   * synonymy. Fusing them recovers most of what either alone would drop.
   */
  async search(input: SearchMemoryInput): Promise<MemorySearchHit[]> {
    const limit = Math.min(input.limit ?? 8, 50);
    const query = input.query.trim();

    const candidates = this.repos.memories.candidates({
      workspaceId: input.workspaceId,
      scopes: input.scopes,
      kinds: input.kinds,
      agentId: input.agentId,
      taskId: input.taskId,
      limit: 400,
    });
    if (candidates.length === 0) return [];

    if (!query) {
      // No query: fall back to the most important, most recent memory.
      return candidates
        .slice(0, limit)
        .map(({ record }) => ({
          record,
          score: record.importance,
          breakdown: {
            semantic: 0,
            keyword: 0,
            importance: record.importance,
            recency: recencyScore(record.updatedAt),
          },
        }));
    }

    const queryVector = await this.embedSafely(query);
    const keywordRanks = this.repos.memories.keywordMatches(input.workspaceId, query, 120);
    const keywordScores = normaliseBm25(keywordRanks);

    const now = Date.now();
    const hits: MemorySearchHit[] = candidates.map(({ record, embedding }) => {
      const semantic =
        queryVector && embedding ? Math.max(0, cosineSimilarity(queryVector, embedding)) : 0;
      const keyword = keywordScores.get(record.id) ?? 0;
      const importance = record.importance;
      const recency = recencyScore(record.updatedAt, now);

      let score =
        WEIGHTS.semantic * semantic +
        WEIGHTS.keyword * keyword +
        WEIGHTS.importance * importance +
        WEIGHTS.recency * recency;

      // Pinned memory is something a human deliberately kept; it always
      // competes for a slot.
      if (record.pinned) score += 0.25;

      return { record, score, breakdown: { semantic, keyword, importance, recency } };
    });

    const minScore = input.minScore ?? 0.12;
    const ranked = hits
      .filter((hit) => hit.record.pinned || hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Usage feeds nothing automatic, but it tells a human which memories are
    // actually doing work — the memory inspector surfaces it.
    this.repos.memories.markUsed(
      ranked.map((h) => h.record.id),
      now,
    );

    return ranked;
  }

  /**
   * Assembles the memory block injected into an agent's prompt.
   *
   * Ordering is deliberate: human feedback and constraints come first, because
   * when the context window forces a truncation the thing that must survive is
   * what a human corrected.
   */
  async buildPromptContext(options: {
    workspaceId: string;
    agentId: string;
    query: string;
    taskId?: string | null;
    maxChars?: number;
  }): Promise<{ text: string; used: MemoryRecord[] }> {
    const maxChars = options.maxChars ?? 6000;

    const [feedback, constraints, general, personal, episodes] = await Promise.all([
      this.search({
        workspaceId: options.workspaceId,
        query: options.query,
        kinds: ['feedback'],
        agentId: options.agentId,
        limit: 5,
        minScore: 0,
      }),
      this.search({
        workspaceId: options.workspaceId,
        query: options.query,
        kinds: ['constraint', 'preference'],
        agentId: options.agentId,
        limit: 5,
        minScore: 0,
      }),
      this.search({
        workspaceId: options.workspaceId,
        query: options.query,
        scopes: ['project'],
        agentId: options.agentId,
        taskId: options.taskId,
        limit: 6,
      }),
      this.search({
        workspaceId: options.workspaceId,
        query: options.query,
        scopes: ['agent'],
        agentId: options.agentId,
        limit: 4,
      }),
      this.search({
        workspaceId: options.workspaceId,
        query: options.query,
        scopes: ['episodic'],
        agentId: options.agentId,
        limit: 4,
      }),
    ]);

    const sections: Array<{ heading: string; hits: MemorySearchHit[] }> = [
      { heading: 'Human feedback you must honour', hits: feedback },
      { heading: 'Constraints and preferences', hits: constraints },
      { heading: 'What the team knows about this project', hits: general },
      { heading: 'Notes specific to your role', hits: personal },
      { heading: 'Relevant past episodes', hits: episodes },
    ];

    const used: MemoryRecord[] = [];
    const seen = new Set<string>();
    const lines: string[] = [];
    let budget = maxChars;

    for (const section of sections) {
      const fresh = section.hits.filter((h) => !seen.has(h.record.id));
      if (fresh.length === 0) continue;

      const header = `\n### ${section.heading}`;
      if (budget - header.length <= 0) break;
      lines.push(header);
      budget -= header.length;

      for (const hit of fresh) {
        const entry = `- **${hit.record.title}** — ${truncate(hit.record.content, 600)}`;
        if (entry.length > budget) continue;
        lines.push(entry);
        budget -= entry.length;
        seen.add(hit.record.id);
        used.push(hit.record);
      }
    }

    if (used.length === 0) {
      return { text: '', used: [] };
    }

    return {
      text: ['## Retrieved memory', ...lines].join('\n'),
      used,
    };
  }

  // -- feedback loop --------------------------------------------------------

  /**
   * Converts a human verdict into memory the relevant agent will retrieve next
   * time.
   *
   * This is the entire "learning" mechanism and it is deliberately not dressed
   * up as anything more: no weights change, no model is fine-tuned. A rejection
   * becomes a high-importance, agent-scoped record that lands at the top of
   * that agent's next prompt.
   */
  async recordFeedback(input: {
    workspaceId: string;
    verdict: FeedbackVerdict;
    comment: string;
    author: ActorRef;
    agentId: string | null;
    taskId: string | null;
    taskTitle?: string;
  }): Promise<MemoryRecord | null> {
    const comment = input.comment.trim();

    // "Looks good" carries no instruction. Storing it would dilute retrieval
    // with noise, so an approval with no substance is recorded as an episode
    // rather than as guidance.
    const substantive = comment.length >= 12;
    if (!substantive && input.verdict === 'approve') {
      if (input.agentId) {
        this.repos.agents.bumpStat(input.agentId, 'feedbackPositive');
      }
      return null;
    }

    const subject = input.taskTitle ? ` on "${truncate(input.taskTitle, 60)}"` : '';
    const verdictLabel: Record<FeedbackVerdict, string> = {
      approve: 'Approved',
      reject: 'Rejected',
      correct: 'Corrected',
      comment: 'Feedback',
    };

    const importance =
      input.verdict === 'reject' || input.verdict === 'correct' ? 0.95 : 0.65;

    const record = await this.write({
      workspaceId: input.workspaceId,
      // Agent-scoped when we know who it is about, so it reaches that agent
      // first; project-scoped otherwise so nobody misses it.
      scope: input.agentId ? 'agent' : 'project',
      kind: 'feedback',
      title: `${verdictLabel[input.verdict]}${subject}`,
      content:
        comment ||
        `A human ${input.verdict === 'approve' ? 'approved' : 'rejected'} this work without further comment.`,
      createdBy: input.author,
      agentId: input.agentId,
      taskId: input.taskId,
      tags: ['feedback', input.verdict],
      importance,
      pinned: input.verdict === 'reject' || input.verdict === 'correct',
      source: 'human-feedback',
    });

    if (input.agentId) {
      this.repos.agents.bumpStat(
        input.agentId,
        input.verdict === 'reject' ? 'feedbackNegative' : 'feedbackPositive',
      );
    }

    return record;
  }

  /** Writes the episodic record for a finished run. */
  async recordEpisode(input: {
    workspaceId: string;
    agentId: string;
    agentName: string;
    taskId: string | null;
    taskTitle: string;
    outcome: 'succeeded' | 'failed' | 'cancelled';
    summary: string;
    durationMs: number;
    toolsUsed: string[];
  }): Promise<MemoryRecord | null> {
    // Cancelled runs teach nothing — a human stopped them for their own reasons.
    if (input.outcome === 'cancelled') return null;

    const content = [
      `Outcome: ${input.outcome}`,
      `Duration: ${Math.round(input.durationMs / 1000)}s`,
      input.toolsUsed.length > 0 ? `Tools used: ${input.toolsUsed.join(', ')}` : null,
      '',
      truncate(input.summary, 1500),
    ]
      .filter((l) => l !== null)
      .join('\n');

    try {
      return await this.write({
        workspaceId: input.workspaceId,
        scope: 'episodic',
        kind: 'episode',
        title: `${input.agentName} ${input.outcome === 'succeeded' ? 'completed' : 'failed'}: ${truncate(input.taskTitle, 70)}`,
        content,
        createdBy: { type: 'agent', id: input.agentId, name: input.agentName },
        agentId: input.agentId,
        taskId: input.taskId,
        tags: ['episode', input.outcome],
        // Failures are more instructive than successes, so they rank higher.
        importance: input.outcome === 'failed' ? 0.8 : 0.45,
        source: 'run-history',
      });
    } catch (err) {
      this.logger.warn('failed to record episode', { error: errorMessage(err) });
      return null;
    }
  }

  // -- reads ----------------------------------------------------------------

  list(workspaceId: string, limit = 300): MemoryRecord[] {
    return this.repos.memories.listForWorkspace(workspaceId, limit);
  }

  byId(id: string): MemoryRecord | null {
    return this.repos.memories.byId(id);
  }

  countFor(workspaceId: string): number {
    return this.repos.memories.countForWorkspace(workspaceId);
  }

  /** Clears the working context for a task once it terminates. */
  clearShortTermForTask(taskId: string): number {
    return this.repos.memories.deleteForTask(taskId, 'short_term');
  }

  // -- internals ------------------------------------------------------------

  /**
   * Embedding is best-effort: a remote embedding provider being down must
   * degrade retrieval to keyword-only, not fail the write or the agent run.
   */
  private async embedSafely(text: string): Promise<Float32Array | null> {
    try {
      const [vector] = await this.embeddings.embed([text.slice(0, 8000)]);
      return vector ?? null;
    } catch (err) {
      this.logger.warn('embedding failed; continuing without a vector', {
        provider: this.embeddings.name,
        error: errorMessage(err),
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function defaultImportance(kind: MemoryKind): number {
  switch (kind) {
    case 'feedback':
      return 0.9;
    case 'constraint':
      return 0.85;
    case 'decision':
      return 0.75;
    case 'preference':
      return 0.7;
    case 'fact':
      return 0.6;
    case 'artifact':
      return 0.5;
    case 'episode':
      return 0.45;
  }
}

function normaliseTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ].slice(0, 12);
}

function recencyScore(updatedAt: number, now = Date.now()): number {
  const age = Math.max(0, now - updatedAt);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/**
 * BM25 in SQLite returns a negative score where more-negative is better.
 * Map the returned window onto 0..1 so it can be fused with cosine similarity.
 */
function normaliseBm25(ranks: Map<string, number>): Map<string, number> {
  if (ranks.size === 0) return new Map();
  const values = [...ranks.values()];
  const best = Math.min(...values);
  const worst = Math.max(...values);
  const span = worst - best;
  const out = new Map<string, number>();
  for (const [id, rank] of ranks) {
    out.set(id, span === 0 ? 1 : 1 - (rank - best) / span);
  }
  return out;
}
