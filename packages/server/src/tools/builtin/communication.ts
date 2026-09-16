import { MAIN_CHANNEL, TOOL_NAMES, taskChannel, truncate } from '@sup/shared';
import {
  fail,
  ok,
  readString,
  schema,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '../types.js';

/**
 * Agent-to-agent and agent-to-human communication.
 *
 * Every one of these is rate-limited and audited by the executor. Agents cannot
 * message each other outside this surface, which is what makes the delegation
 * graph in the UI a complete picture rather than a sample.
 */

function resolveAgent(ctx: ToolContext, nameOrId: string) {
  const byId = ctx.repos.agents.byId(nameOrId);
  if (byId && byId.workspaceId === ctx.workspace.id) return byId;
  return ctx.repos.agents.byNameInWorkspace(ctx.workspace.id, nameOrId.replace(/^@/, ''));
}

export const sendMessageTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.sendMessage,
    category: 'communication',
    title: 'Send message',
    description:
      'Post a message into the shared workspace. Use this to keep humans and teammates informed. ' +
      'This is a broadcast, not a request — it does not wait for a reply and does not assign work.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        body: { type: 'string', description: 'The message text. Markdown is supported.' },
        to: {
          type: 'string',
          description: 'Optional agent name to address directly. Omit to post to the whole room.',
        },
      },
      ['body'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const body = readString(input, 'body').trim();
    if (!body) return fail('Message body was empty');

    const toName = readString(input, 'to').trim();
    const recipient = toName ? resolveAgent(ctx, toName) : null;
    if (toName && !recipient) return fail(`No agent named "${toName}" in this workspace`);

    const posted = ctx.services.postAgentMessage({
      ctx,
      channel: ctx.task ? taskChannel(ctx.task.id) : MAIN_CHANNEL,
      body,
      recipient: recipient ? { type: 'agent', id: recipient.id, name: recipient.name } : null,
      kind: recipient ? 'agent_to_agent' : 'chat',
      toAgentId: recipient?.id ?? null,
    });

    if (!posted.ok) return fail(posted.reason ?? 'Message was not delivered');
    return ok(
      recipient ? `Messaged ${recipient.name}` : 'Posted to the workspace',
      { delivered: true, to: recipient?.name ?? 'workspace' },
    );
  },
};

export const askAgentTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.askAgent,
    category: 'communication',
    title: 'Ask another agent',
    description:
      'Ask a specific teammate a focused question and wait for their answer. ' +
      'Use this for a quick input you need; use delegate_task when you want them to own a piece of work.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        agent: { type: 'string', description: 'Name of the agent to ask.' },
        question: { type: 'string', description: 'The question. Be specific and self-contained.' },
      },
      ['agent', 'question'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const agentName = readString(input, 'agent').trim();
    const question = readString(input, 'question').trim();
    if (!agentName || !question) return fail('ask_agent needs both an agent and a question');

    const target = resolveAgent(ctx, agentName);
    if (!target) return fail(`No agent named "${agentName}" in this workspace`);
    if (target.id === ctx.agent.id) return fail('An agent cannot ask itself');

    const outcome = await ctx.services.delegateAndWait({
      ctx,
      toAgentId: target.id,
      title: `Question from ${ctx.agent.name}: ${truncate(question, 60)}`,
      description: question,
      dependsOn: [],
      relation: 'ask',
      priority: 'high',
    });

    if (!outcome.ok) {
      return fail(`${target.name} could not answer`, outcome.error ?? undefined);
    }
    return ok(`${target.name} answered`, { agent: target.name, answer: outcome.result });
  },
};

export const askHumanTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.askHuman,
    category: 'communication',
    title: 'Ask a human',
    description:
      'Ask the humans in the workspace for a decision or missing information, and wait for a reply. ' +
      'Only use this when the answer genuinely changes what you will produce and you cannot reasonably decide yourself.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        question: { type: 'string', description: 'The question to put to the humans.' },
        timeout_seconds: {
          type: 'integer',
          description: 'How long to wait before proceeding without an answer. Default 180.',
          minimum: 10,
          maximum: 1800,
        },
      },
      ['question'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const question = readString(input, 'question').trim();
    if (!question) return fail('ask_human needs a question');

    const timeoutMs = Math.min(
      1_800_000,
      Math.max(10_000, Number(input.timeout_seconds ?? 180) * 1000),
    );

    const outcome = await ctx.services.askHuman({ ctx, question, timeoutMs });

    if (!outcome.answered) {
      // A timeout is not an error: the agent should proceed on its best
      // judgement rather than failing the task because nobody was watching.
      return ok('No human answered in time; proceeding on best judgement', {
        answered: false,
        guidance:
          'No human responded. Continue with the most reasonable assumption and state clearly in your result what you assumed.',
      });
    }
    return ok('A human answered', { answered: true, answer: outcome.answer });
  },
};

export const broadcastEventTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.broadcastEvent,
    category: 'communication',
    title: 'Broadcast a notice',
    description:
      'Publish a notice to the workspace activity stream. Use for milestones and warnings that everyone should see, not for routine chatter.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        message: { type: 'string', description: 'What happened.' },
        level: {
          type: 'string',
          description: 'Severity of the notice.',
          enum: ['info', 'warn', 'error'],
        },
      },
      ['message'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const message = readString(input, 'message').trim();
    if (!message) return fail('broadcast_event needs a message');
    const level = readString(input, 'level', 'info');

    ctx.events.publish(ctx.workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: ctx.actor,
      payload: {
        level: level === 'warn' || level === 'error' ? level : 'info',
        message: truncate(message, 500),
      } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });

    return ok('Notice broadcast to the workspace', { broadcast: true });
  },
};

export const returnResultTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.returnResult,
    category: 'communication',
    title: 'Return result',
    description:
      'Hand your finished work back and close your task. Call this exactly once, when you are done. ' +
      'Everything the requester needs must be in `result` — nothing else you produced is returned automatically.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        summary: { type: 'string', description: 'One line describing what you produced.' },
        result: { type: 'string', description: 'The full deliverable.' },
        artifact_path: {
          type: 'string',
          description: 'Optional path of a workspace file holding the deliverable.',
        },
      },
      ['summary', 'result'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const summary = readString(input, 'summary').trim();
    const result = readString(input, 'result').trim();
    if (!result) return fail('return_result needs a non-empty result');

    // The runtime detects this tool by name and ends the run; the payload it
    // reads is this structured data.
    return ok(summary || 'Result returned', {
      summary,
      result,
      artifact_path: readString(input, 'artifact_path') || null,
    });
  },
};

export const communicationTools: Tool[] = [
  sendMessageTool,
  askAgentTool,
  askHumanTool,
  broadcastEventTool,
  returnResultTool,
];
