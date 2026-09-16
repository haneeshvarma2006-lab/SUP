import { truncate, type Agent, type Task, type Workspace } from '@sup/shared';
import type { MemoryService } from '../memory/memoryService.js';
import type { Repositories } from '../db/repos/index.js';
import type { ToolSpec } from '../ai/provider.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface PromptInputs {
  workspace: Workspace;
  agent: Agent;
  task: Task | null;
  objective: string;
  /** Teammates this agent can address, with their roles. */
  roster: Array<{ name: string; role: string; status: string; isOrchestrator: boolean }>;
  memoryText: string;
  depth: number;
  remainingDelegations: number;
}

/**
 * Assembles the system prompt.
 *
 * Structure is deliberate and stable: identity, the room, the task, then
 * memory, then operating rules. Keeping the layout fixed across runs means
 * prompt caching works and that a change in behaviour can be traced to a change
 * in retrieved memory rather than to prompt churn.
 */
export function buildSystemPrompt(inputs: PromptInputs): string {
  const { workspace, agent, task } = inputs;

  const sections: string[] = [];

  sections.push(
    [
      `You are ${agent.name}, the ${agent.role} in the shared workspace "${workspace.name}".`,
      agent.tagline ? `Your remit: ${agent.tagline}` : '',
      '',
      agent.systemInstructions,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (inputs.roster.length > 0) {
    sections.push(
      [
        '## Who else is in this workspace',
        '',
        'Address teammates by the exact name shown here.',
        '',
        ...inputs.roster.map(
          (r) =>
            `- **${r.name}** — ${r.role}${r.isOrchestrator ? ' (orchestrator)' : ''}, currently ${r.status}`,
        ),
      ].join('\n'),
    );
  }

  if (inputs.objective) {
    sections.push(`## The objective everyone is serving\n\n${truncate(inputs.objective, 2000)}`);
  }

  if (task) {
    sections.push(
      [
        '## Your task',
        '',
        `**${task.title}**`,
        '',
        task.description || '(no further description was given)',
        '',
        `Priority: ${task.priority}. Task id: ${task.id}.`,
        task.requiresHumanApproval
          ? 'A human must approve your result before this task closes.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (inputs.memoryText) {
    sections.push(
      [
        inputs.memoryText,
        '',
        'This memory was retrieved for you because it looked relevant. Use it. If something here',
        'contradicts your instincts, the memory wins — a human put most of it there.',
      ].join('\n'),
    );
  }

  const rules = [
    '## How to operate here',
    '',
    '- Act through tools. Describing an action you did not take is a failure.',
    '- Finish by calling `return_result` exactly once. Nothing you did is returned automatically —',
    '  whatever the requester needs must be in that call.',
    '- Do not repeat a tool call that already succeeded. Read the result you were given.',
    '- Never invent specifics. If you do not have a source, number or name, say so.',
  ];

  if (inputs.depth > 0) {
    rules.push(
      `- You are at delegation depth ${inputs.depth}. You were given this work by a teammate;`,
      '  do your piece and return it rather than re-planning the objective.',
    );
  }
  if (inputs.remainingDelegations <= 0) {
    rules.push(
      '- The delegation budget for this objective is spent. Complete the work yourself and return it.',
    );
  } else if (inputs.remainingDelegations < 5) {
    rules.push(
      `- Only ${inputs.remainingDelegations} delegation(s) remain for this objective. Spend them carefully.`,
    );
  }

  sections.push(rules.join('\n'));

  return sections.join('\n\n---\n\n');
}

export interface UpstreamResult {
  title: string;
  author: string;
  result: string;
}

/** Builds the first user turn: what actually kicks the agent off. */
export function buildOpeningMessage(inputs: {
  task: Task | null;
  objective: string;
  priorMessages: Array<{ author: string; body: string }>;
  upstream: UpstreamResult[];
}): string {
  const parts: string[] = [];

  if (inputs.task) {
    parts.push(`Please carry out your task: **${inputs.task.title}**`);
    if (inputs.task.description) parts.push(inputs.task.description);
  } else {
    parts.push(inputs.objective);
  }

  // Work this task depends on has already produced output. Handing it over is
  // what makes a pipeline a pipeline — without it an analyst would be asked to
  // analyse research it has never seen.
  if (inputs.upstream.length > 0) {
    parts.push(
      [
        '',
        '## Output from the work this task depends on',
        '',
        'This is your input. Build on it; do not redo it, and do not contradict it without saying why.',
        '',
        ...inputs.upstream.map((u) =>
          [`### ${u.title}`, `_produced by ${u.author}_`, '', truncate(u.result, 6000)].join('\n'),
        ),
      ].join('\n'),
    );
  }

  if (inputs.priorMessages.length > 0) {
    parts.push(
      [
        '',
        'Recent conversation in the workspace, for context:',
        '',
        ...inputs.priorMessages.map((m) => `**${m.author}:** ${truncate(m.body, 500)}`),
      ].join('\n'),
    );
  }

  parts.push('', 'Begin. Remember to finish with `return_result`.');
  return parts.join('\n');
}

/** Converts the tools an agent may use into provider-facing specs. */
export function buildToolSpecs(agent: Agent, registry: ToolRegistry): ToolSpec[] {
  return registry.descriptorsFor(agent.capabilities, agent.isOrchestrator).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object' as const,
      properties: descriptor.parameters.properties as Record<string, unknown>,
      required: descriptor.parameters.required ?? [],
    },
  }));
}

/** Gathers the roster line shown to an agent, excluding itself. */
export function buildRoster(
  repos: Repositories,
  workspaceId: string,
  excludeAgentId: string,
): PromptInputs['roster'] {
  return repos.agents
    .listForWorkspace(workspaceId)
    .filter((a) => a.id !== excludeAgentId && a.enabled)
    .map((a) => ({
      name: a.name,
      role: a.role,
      status: a.paused ? 'paused' : a.status,
      isOrchestrator: a.isOrchestrator,
    }));
}

/** Retrieves and formats the memory block for a run. */
export async function buildMemoryBlock(
  memory: MemoryService,
  options: { workspaceId: string; agentId: string; query: string; taskId: string | null },
): Promise<{ text: string; usedIds: string[] }> {
  const { text, used } = await memory.buildPromptContext({
    workspaceId: options.workspaceId,
    agentId: options.agentId,
    query: options.query,
    taskId: options.taskId,
  });
  return { text, usedIds: used.map((m) => m.id) };
}
