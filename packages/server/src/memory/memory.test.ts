import { afterEach, describe, expect, it } from 'vitest';
import { LocalHashEmbeddingProvider, cosineSimilarity } from '../ai/embeddings.js';
import { toFtsQuery } from '../db/repos/memory.js';
import { createTestWorkspace, type TestWorkspace } from '../testing/harness.js';

let harness: TestWorkspace | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const author = { type: 'user' as const, id: 'usr_test', name: 'Tester' };

describe('LocalHashEmbeddingProvider', () => {
  const provider = new LocalHashEmbeddingProvider(384);

  it('is deterministic', () => {
    const a = provider.embedOne('competitor pricing analysis');
    const b = provider.embedOne('competitor pricing analysis');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('produces unit vectors', () => {
    const v = provider.embedOne('some text with several words in it');
    const norm = Math.sqrt([...v].reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('scores overlapping text above unrelated text', () => {
    const query = provider.embedOne('competitor pricing for developer tools');
    const related = provider.embedOne('pricing comparison across developer tooling competitors');
    const unrelated = provider.embedOne('the migratory patterns of arctic terns');

    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('tolerates a typo through character shingles', () => {
    const query = provider.embedOne('competitor analysis');
    const typo = provider.embedOne('competiter analysis');
    const other = provider.embedOne('quarterly payroll reconciliation');
    expect(cosineSimilarity(query, typo)).toBeGreaterThan(cosineSimilarity(query, other));
  });

  it('returns a zero vector for empty input without dividing by zero', () => {
    const v = provider.embedOne('');
    expect([...v].every((x) => x === 0)).toBe(true);
    expect(Number.isNaN(cosineSimilarity(v, v))).toBe(false);
  });
});

describe('toFtsQuery', () => {
  it('quotes every token so punctuation cannot break the query', () => {
    expect(toFtsQuery('pricing AND "competitors"')).toBe('"pricing" OR "competitors"');
  });

  it('drops stop words and very short tokens', () => {
    expect(toFtsQuery('the and of a')).toBeNull();
  });

  it('neutralises an FTS injection attempt', () => {
    // Without quoting, a NEAR/ operator here would change the query's meaning.
    const query = toFtsQuery('foo NEAR/2 bar" OR 1=1 --');
    expect(query).not.toBeNull();
    expect(query!).not.toContain('NEAR/');
    expect(query!.split(' OR ').every((t) => /^"[a-z0-9]+"$/.test(t))).toBe(true);
  });
});

describe('MemoryService', () => {
  it('stores, scopes and retrieves memory', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const { app, workspace } = harness;
    const researcher = harness.agentWithRole('Researcher');

    await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'constraint',
      title: 'Budget ceiling',
      content: 'Never recommend a tool costing more than $200 per seat per month.',
      createdBy: author,
      tags: ['budget'],
    });

    const hits = await app.memory.search({
      workspaceId: workspace.id,
      query: 'how much can we spend per seat',
      agentId: researcher.id,
      limit: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.title).toBe('Budget ceiling');
    expect(hits[0]!.breakdown.importance).toBeGreaterThan(0.5);
  });

  it('deduplicates identical content instead of piling up copies', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const first = await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'fact',
      title: 'Same fact',
      content: 'The primary competitor is Acme.',
      createdBy: author,
      importance: 0.5,
    });

    const second = await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'fact',
      // Casing and surrounding whitespace should not defeat dedupe.
      title: '  same fact ',
      content: 'The Primary Competitor is Acme.',
      createdBy: author,
      importance: 0.5,
    });

    expect(second.id).toBe(first.id);
    // Repetition is evidence of salience, so importance is nudged up.
    expect(second.importance).toBeGreaterThan(first.importance);
    expect(app.memory.countFor(workspace.id)).toBe(1);
  });

  it('keeps agent-scoped memory private to its agent', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher', 'analyst'] });
    const { app, workspace } = harness;
    const researcher = harness.agentWithRole('Researcher');
    const analyst = harness.agentWithRole('Analyst');

    await app.memory.write({
      workspaceId: workspace.id,
      scope: 'agent',
      kind: 'preference',
      title: 'Researcher note',
      content: 'Prefer primary sources over aggregator blogs when researching vendors.',
      createdBy: author,
      agentId: researcher.id,
    });

    const own = await app.memory.search({
      workspaceId: workspace.id,
      query: 'primary sources vendors',
      agentId: researcher.id,
    });
    expect(own.some((h) => h.record.title === 'Researcher note')).toBe(true);

    const other = await app.memory.search({
      workspaceId: workspace.id,
      query: 'primary sources vendors',
      agentId: analyst.id,
    });
    expect(other.some((h) => h.record.title === 'Researcher note')).toBe(false);
  });

  it('ranks a pinned memory into the results even on a weak match', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'constraint',
      title: 'Never contact competitors directly',
      content: 'Do not email or call a competitor for information. Use public sources only.',
      createdBy: author,
      pinned: true,
    });

    for (let i = 0; i < 10; i++) {
      await app.memory.write({
        workspaceId: workspace.id,
        scope: 'project',
        kind: 'fact',
        title: `Filler ${i}`,
        content: `An unrelated observation number ${i} about quarterly widget throughput.`,
        createdBy: author,
      });
    }

    const hits = await app.memory.search({
      workspaceId: workspace.id,
      query: 'widget throughput',
      limit: 20,
    });
    expect(hits.some((h) => h.record.pinned)).toBe(true);
  });

  it('records a rejection as high-importance, pinned, agent-scoped memory', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'writer'] });
    const { app, workspace } = harness;
    const writer = harness.agentWithRole('Writer');

    const record = await app.memory.recordFeedback({
      workspaceId: workspace.id,
      verdict: 'reject',
      comment: 'The report buried the recommendation on page four. Lead with it.',
      author,
      agentId: writer.id,
      taskId: null,
      taskTitle: 'Write the report',
    });

    expect(record).not.toBeNull();
    expect(record!.scope).toBe('agent');
    expect(record!.kind).toBe('feedback');
    expect(record!.pinned).toBe(true);
    expect(record!.importance).toBeGreaterThan(0.9);
    expect(app.repos.agents.byId(writer.id)!.stats.feedbackNegative).toBe(1);
  });

  it('does not store a contentless approval as guidance', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'writer'] });
    const { app, workspace } = harness;
    const writer = harness.agentWithRole('Writer');

    const record = await app.memory.recordFeedback({
      workspaceId: workspace.id,
      verdict: 'approve',
      comment: 'nice',
      author,
      agentId: writer.id,
      taskId: null,
    });

    // "nice" is not instruction; storing it would just dilute retrieval.
    expect(record).toBeNull();
    expect(app.repos.agents.byId(writer.id)!.stats.feedbackPositive).toBe(1);
  });

  it('puts human feedback ahead of general facts in the prompt block', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'analyst'] });
    const { app, workspace } = harness;
    const analyst = harness.agentWithRole('Analyst');

    await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'fact',
      title: 'Market size',
      content: 'The developer tools market was estimated at some size in a report we read.',
      createdBy: author,
    });

    await app.memory.recordFeedback({
      workspaceId: workspace.id,
      verdict: 'correct',
      comment: 'Always include a confidence level next to every market-size figure.',
      author,
      agentId: analyst.id,
      taskId: null,
    });

    const context = await app.memory.buildPromptContext({
      workspaceId: workspace.id,
      agentId: analyst.id,
      query: 'developer tools market size',
    });

    const feedbackAt = context.text.indexOf('Human feedback you must honour');
    const factsAt = context.text.indexOf('What the team knows about this project');
    expect(feedbackAt).toBeGreaterThanOrEqual(0);
    expect(feedbackAt).toBeLessThan(factsAt);
  });

  it('respects the prompt-context character budget', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;
    const orchestrator = harness.agentWithRole('Orchestrator');

    for (let i = 0; i < 40; i++) {
      await app.memory.write({
        workspaceId: workspace.id,
        scope: 'project',
        kind: 'fact',
        title: `Competitor ${i}`,
        content: 'x'.repeat(500),
        createdBy: author,
      });
    }

    const context = await app.memory.buildPromptContext({
      workspaceId: workspace.id,
      agentId: orchestrator.id,
      query: 'competitor',
      maxChars: 1200,
    });

    expect(context.text.length).toBeLessThan(2000);
    expect(context.used.length).toBeGreaterThan(0);
  });

  it('supports editing and deleting a memory', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const record = await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'fact',
      title: 'Wrong fact',
      content: 'Acme charges $50 per seat.',
      createdBy: author,
    });

    const corrected = await app.memory.update(
      record.id,
      { content: 'Acme charges $80 per seat.', title: 'Corrected fact' },
      author,
    );
    expect(corrected.content).toContain('$80');

    // The edit is retrievable, which is the point of editable memory: it takes
    // effect on the very next run.
    const hits = await app.memory.search({
      workspaceId: workspace.id,
      query: 'Acme per seat price',
    });
    expect(hits[0]!.record.content).toContain('$80');

    app.memory.delete(record.id, author);
    expect(app.memory.byId(record.id)).toBeNull();
  });

  it('prunes short-term memory but keeps durable scopes', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    await app.memory.write({
      workspaceId: workspace.id,
      scope: 'project',
      kind: 'fact',
      title: 'Durable',
      content: 'This must survive short-term pruning.',
      createdBy: author,
    });

    for (let i = 0; i < 220; i++) {
      await app.memory.write({
        workspaceId: workspace.id,
        scope: 'short_term',
        kind: 'fact',
        title: `Scratch ${i}`,
        content: `working note ${i}`,
        createdBy: author,
      });
    }

    const all = app.repos.memories.listForWorkspace(workspace.id, 500);
    expect(all.filter((m) => m.scope === 'short_term').length).toBeLessThanOrEqual(200);
    expect(all.some((m) => m.title === 'Durable')).toBe(true);
  });

  it('rejects empty and oversized writes', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    await expect(
      app.memory.write({
        workspaceId: workspace.id,
        scope: 'project',
        kind: 'fact',
        title: '',
        content: 'body',
        createdBy: author,
      }),
    ).rejects.toThrow(/title/i);

    await expect(
      app.memory.write({
        workspaceId: workspace.id,
        scope: 'project',
        kind: 'fact',
        title: 'Huge',
        content: 'x'.repeat(20_001),
        createdBy: author,
      }),
    ).rejects.toThrow(/too large/i);
  });
});
