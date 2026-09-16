import { TOOL_NAMES, truncate, type MemoryKind, type MemoryScope } from '@sup/shared';
import { fail, ok, readNumber, readString, readStringArray, schema, type Tool, type ToolResult } from '../types.js';

const SCOPES: MemoryScope[] = ['short_term', 'project', 'agent', 'episodic'];
const KINDS: MemoryKind[] = ['fact', 'preference', 'decision', 'feedback', 'episode', 'artifact', 'constraint'];

export const memorySearchTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.memorySearch,
    category: 'memory',
    title: 'Search memory',
    description:
      'Search what the team has learned on this project: facts, decisions, constraints, human feedback and past episodes. ' +
      'Do this before starting work so you honour what was already decided.',
    risk: 'safe',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        query: { type: 'string', description: 'What you want to know.' },
        scope: {
          type: 'string',
          enum: [...SCOPES, 'all'],
          description: 'Restrict to one memory scope. Defaults to all.',
        },
        kind: { type: 'string', enum: KINDS, description: 'Restrict to one kind of memory.' },
        limit: { type: 'integer', description: 'Max results (default 6, max 20).', minimum: 1, maximum: 20 },
      },
      ['query'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const query = readString(input, 'query').trim();
    if (!query) return fail('memory_search needs a query');

    const scope = readString(input, 'scope', 'all');
    const kind = readString(input, 'kind');

    const hits = await ctx.memory.search({
      workspaceId: ctx.workspace.id,
      query,
      agentId: ctx.agent.id,
      taskId: ctx.task?.id ?? null,
      scopes: SCOPES.includes(scope as MemoryScope) ? [scope as MemoryScope] : undefined,
      kinds: KINDS.includes(kind as MemoryKind) ? [kind as MemoryKind] : undefined,
      limit: Math.min(20, Math.max(1, readNumber(input, 'limit', 6))),
    });

    if (hits.length === 0) {
      return ok('No relevant memory found', {
        results: [],
        note: 'Nothing stored matches this query. Treat the project as new ground.',
      });
    }

    return ok(`${hits.length} memory item(s) found`, {
      results: hits.map((hit) => ({
        id: hit.record.id,
        scope: hit.record.scope,
        kind: hit.record.kind,
        title: hit.record.title,
        content: hit.record.content,
        tags: hit.record.tags,
        relevance: Number(hit.score.toFixed(3)),
      })),
    });
  },
};

export const memoryWriteTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.memoryWrite,
    category: 'memory',
    title: 'Write memory',
    description:
      'Record something durable the team will need later: a fact, a decision and its reasoning, a constraint, or a preference. ' +
      'Be selective — write what a teammate would need next week, not a transcript of what you just did.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        title: { type: 'string', description: 'Short label. This is what shows in the memory list.' },
        content: { type: 'string', description: 'The substance, self-contained enough to be useful out of context.' },
        scope: {
          type: 'string',
          enum: SCOPES,
          description:
            'project = the whole team needs it; agent = only relevant to your own role; episodic = what happened; short_term = current task only.',
        },
        kind: { type: 'string', enum: KINDS, description: 'What sort of memory this is.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
        importance: {
          type: 'number',
          description: '0 to 1. Higher ranks it earlier in future retrieval.',
          minimum: 0,
          maximum: 1,
        },
      },
      ['title', 'content'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const title = readString(input, 'title').trim();
    const content = readString(input, 'content').trim();
    if (!title || !content) return fail('memory_write needs a title and content');

    const scope = readString(input, 'scope', 'project');
    const kind = readString(input, 'kind', 'fact');

    const record = await ctx.memory.write({
      workspaceId: ctx.workspace.id,
      scope: SCOPES.includes(scope as MemoryScope) ? (scope as MemoryScope) : 'project',
      kind: KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'fact',
      title: truncate(title, 140),
      content,
      createdBy: ctx.actor,
      agentId: ctx.agent.id,
      taskId: ctx.task?.id ?? null,
      tags: readStringArray(input, 'tags'),
      importance: readNumber(input, 'importance', 0.6),
      source: `run:${ctx.run.id}`,
    });

    return ok(`Remembered "${truncate(record.title, 60)}"`, {
      memory_id: record.id,
      scope: record.scope,
      kind: record.kind,
    });
  },
};

export const memoryTools: Tool[] = [memorySearchTool, memoryWriteTool];
