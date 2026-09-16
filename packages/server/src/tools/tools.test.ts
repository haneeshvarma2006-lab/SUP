import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_RUN_USAGE, TOOL_NAMES, type Agent, type AgentRun } from '@sup/shared';
import { createTestWorkspace, type TestWorkspace } from '../testing/harness.js';
import { isPrivateHost } from './builtin/external.js';
import { normaliseWorkspacePath as normalisePath } from './builtin/files.js';
import { redactForDisplay } from './executor.js';
import type { ToolContext } from './types.js';

let harness: TestWorkspace | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

/** Builds a real ToolContext so tools are exercised through their true surface. */
function contextFor(h: TestWorkspace, agent: Agent, capabilities?: string[]): ToolContext {
  const { app, workspace } = h;
  const effective = capabilities ? app.repos.agents.update(agent.id, { capabilities })! : agent;

  const run: AgentRun = {
    id: 'run_test',
    workspaceId: workspace.id,
    agentId: agent.id,
    taskId: null,
    status: 'running',
    depth: 0,
    objectiveId: 'obj_test',
    attempt: 1,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    result: null,
    usage: { ...EMPTY_RUN_USAGE },
    steps: [],
  };

  return {
    workspace: app.workspaces.requireWorkspace(workspace.id),
    agent: effective,
    run,
    task: null,
    actor: { type: 'agent', id: agent.id, name: agent.name },
    objectiveId: 'obj_test',
    depth: 0,
    signal: new AbortController().signal,
    config: app.config,
    repos: app.repos,
    events: app.events,
    memory: app.memory,
    logger: app.logger,
    services: app.orchestration,
    blocking: { whileBlocked: async (fn) => fn() },
  };
}

describe('tool permission boundary', () => {
  it('refuses a tool the agent was not granted', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'reviewer'] });
    const reviewer = harness.agentWithRole('Reviewer');

    // The reviewer template deliberately has no code execution.
    expect(reviewer.capabilities).not.toContain(TOOL_NAMES.codeExec);

    const ctx = contextFor(harness, reviewer);
    const result = await harness.app.toolExecutor.execute(
      { callId: 'c1', name: TOOL_NAMES.codeExec, input: { language: 'python', source: 'print(1)' } },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/denied/i);
    // The agent is told what it *can* use, so it can adapt rather than retry.
    expect(result.content).toMatch(/does not grant/);
    expect(harness.eventsOfType('TOOL_DENIED')).toHaveLength(1);
  });

  it('refuses a tool that does not exist at all', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const orchestrator = harness.agentWithRole('Orchestrator');
    const ctx = contextFor(harness, orchestrator);

    const result = await harness.app.toolExecutor.execute(
      { callId: 'c1', name: 'rm_rf_everything', input: {} },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/No such tool/);
  });

  it('audits denials as well as successes', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'reviewer'] });
    const reviewer = harness.agentWithRole('Reviewer');
    const ctx = contextFor(harness, reviewer);

    await harness.app.toolExecutor.execute(
      { callId: 'c1', name: TOOL_NAMES.codeExec, input: {} },
      ctx,
    );
    await harness.app.toolExecutor.execute(
      { callId: 'c2', name: TOOL_NAMES.memorySearch, input: { query: 'anything' } },
      ctx,
    );

    const audit = harness.app.repos.toolAudit.listForAgent(reviewer.id, 10);
    expect(audit.map((a) => a.outcome)).toEqual(expect.arrayContaining(['denied', 'ok']));
  });

  it('rejects an agent configured with an unknown tool', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    expect(() =>
      harness!.app.workspaces.createAgent(
        {
          workspaceId: harness!.workspace.id,
          name: 'Ghost',
          role: 'Ghost',
          systemInstructions: 'x',
          capabilities: ['not_a_real_tool'],
        },
        { type: 'system', id: 'system' },
      ),
    ).toThrow(/Unknown tool/);
  });
});

describe('workspace file tools', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(normalisePath('../../etc/passwd')).toBeNull();
    expect(normalisePath('a/../../b')).toBeNull();
    expect(normalisePath('/etc/passwd')).toBe('etc/passwd');
    expect(normalisePath('reports/./x.md')).toBeNull();
    expect(normalisePath('a/b/c/d/e/f/g/h/i/j.md')).toBeNull();
    expect(normalisePath('reports/x;rm -rf.md')).toBeNull();
    expect(normalisePath('')).toBeNull();
  });

  it('accepts ordinary workspace paths', () => {
    expect(normalisePath('reports/competitors.md')).toBe('reports/competitors.md');
    expect(normalisePath('  notes.txt ')).toBe('notes.txt');
    expect(normalisePath('a b/c-d_e.2.md')).toBe('a b/c-d_e.2.md');
  });

  it('versions a file rather than silently replacing it', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'writer'] });
    const { app, workspace } = harness;
    const writer = harness.agentWithRole('Writer');
    const ctx = contextFor(harness, writer);

    const first = await app.toolExecutor.execute(
      { callId: 'c1', name: TOOL_NAMES.fileWrite, input: { path: 'notes.md', content: 'v1' } },
      ctx,
    );
    const second = await app.toolExecutor.execute(
      { callId: 'c2', name: TOOL_NAMES.fileWrite, input: { path: 'notes.md', content: 'v2' } },
      ctx,
    );

    expect(first.ok && second.ok).toBe(true);
    const file = app.repos.files.byPath(workspace.id, 'notes.md')!;
    expect(file.version).toBe(2);
    expect(file.content).toBe('v2');
  });

  it('refuses a file over the size limit', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'writer'] });
    const writer = harness.agentWithRole('Writer');
    const ctx = contextFor(harness, writer);

    const result = await harness.app.toolExecutor.execute(
      {
        callId: 'c1',
        name: TOOL_NAMES.fileWrite,
        input: { path: 'huge.md', content: 'x'.repeat(600_000) },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/limit/i);
  });

  it('tells an agent what files exist when a read misses', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'writer'] });
    const writer = harness.agentWithRole('Writer');
    const ctx = contextFor(harness, writer);

    await harness.app.toolExecutor.execute(
      { callId: 'c1', name: TOOL_NAMES.fileWrite, input: { path: 'exists.md', content: 'hi' } },
      ctx,
    );
    const miss = await harness.app.toolExecutor.execute(
      { callId: 'c2', name: TOOL_NAMES.fileRead, input: { path: 'missing.md' } },
      ctx,
    );

    expect(miss.ok).toBe(false);
    expect(miss.content).toContain('exists.md');
  });
});

describe('SSRF guard', () => {
  it('blocks loopback, private ranges and cloud metadata', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      'db.internal',
    ]) {
      expect(isPrivateHost(host), `${host} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public hosts', () => {
    for (const host of ['example.com', '8.8.8.8', 'api.github.com', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateHost(host), `${host} should be allowed`).toBe(false);
    }
  });
});

describe('redactForDisplay', () => {
  it('masks credential-shaped keys', () => {
    const redacted = redactForDisplay({
      query: 'ok',
      api_key: 'sk-secret',
      nested: { authorization: 'Bearer abc', password: 'hunter2' },
    }) as Record<string, unknown>;

    expect(redacted.query).toBe('ok');
    expect(redacted.api_key).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('truncates long strings and deep structures', () => {
    const redacted = redactForDisplay({ body: 'x'.repeat(5000) }) as { body: string };
    expect(redacted.body.length).toBeLessThan(700);

    let deep: unknown = 'bottom';
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redactForDisplay(deep))).toContain('…');
  });
});

describe('code sandbox', () => {
  it('runs a program and captures stdout', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const result = await harness.app.sandbox.execute({
      language: 'javascript',
      source: 'console.log(6 * 7)',
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit with stderr rather than swallowing it', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const result = await harness.app.sandbox.execute({
      language: 'javascript',
      source: 'throw new Error("deliberate failure")',
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('deliberate failure');
  });

  it('kills a program that exceeds its time budget', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const result = await harness.app.sandbox.execute({
      language: 'javascript',
      source: 'while (true) {}',
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });

    expect(result.timedOut).toBe(true);
  }, 20_000);

  it('does not leak the server environment into the child', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    process.env.SUP_SECRET_CANARY = 'must-not-leak';
    try {
      const result = await harness.app.sandbox.execute({
        language: 'javascript',
        source: 'console.log(JSON.stringify(process.env.SUP_SECRET_CANARY ?? null))',
        timeoutMs: 15_000,
        signal: new AbortController().signal,
      });
      expect(result.stdout.trim()).toBe('null');
    } finally {
      delete process.env.SUP_SECRET_CANARY;
    }
  });

  it('rejects an unsupported language cleanly', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const result = await harness.app.sandbox.execute({
      language: 'brainfuck',
      source: '+++',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/Unsupported language/);
  });
});

describe('web search without a provider', () => {
  it('returns nothing and says so, rather than inventing results', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const researcher = harness.agentWithRole('Researcher');
    const ctx = contextFor(harness, researcher);

    const result = await harness.app.toolExecutor.execute(
      { callId: 'c1', name: TOOL_NAMES.webSearch, input: { query: 'competitors' } },
      ctx,
    );

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.content) as { results: unknown[]; note: string };
    expect(payload.results).toEqual([]);
    expect(payload.note).toMatch(/No search was performed|no provider/i);
  });
});




