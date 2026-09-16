import { ID_PREFIXES, newId, truncate } from '@sup/shared';
import type { AppConfig } from '../config/index.js';
import type { Repositories, ToolAuditEntry } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import { RateLimiter } from '../concurrency/retry.js';
import { withTimeout } from '../concurrency/cancellation.js';
import { CancellationError, errorMessage, isCancellation } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { ToolRegistry } from './registry.js';
import { fail, type ToolContext, type ToolResult } from './types.js';

export interface ToolInvocation {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The single gate every tool call passes through.
 *
 * Order matters and is deliberate:
 *   1. Does the tool exist?
 *   2. Is the agent permitted to call it? (capability list, orchestrator-only)
 *   3. Is the agent within its tool-call budget?
 *   4. Does the workspace require a human to approve it?
 *   5. Execute, with a timeout and a cancellation signal.
 *   6. Audit, always — including denials and failures.
 *
 * A model asking for a tool it was never granted is refused here, not filtered
 * out of the prompt and quietly ignored: the agent gets an explicit denial it
 * can reason about, and the workspace sees a TOOL_DENIED event.
 */
export class ToolExecutor {
  private readonly toolRateLimiter: RateLimiter;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly repos: Repositories,
    private readonly events: EventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    // Generous per-agent ceiling: this is a runaway guard, not a throttle on
    // legitimate work. Per-run step limits do the real bounding.
    this.toolRateLimiter = new RateLimiter(120, 60_000);
  }

  async execute(invocation: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { name, input, callId } = invocation;

    const denial = this.checkAllowed(name, ctx);
    if (denial) {
      this.emitDenied(name, denial, ctx);
      this.audit(ctx, name, input, 'denied', denial, 0);
      return fail(`Tool "${name}" was denied`, denial);
    }

    const tool = this.registry.get(name)!;

    this.events.publish(ctx.workspace.id, {
      type: 'TOOL_CALLED',
      actor: ctx.actor,
      payload: {
        agentId: ctx.agent.id,
        runId: ctx.run.id,
        toolName: name,
        callId,
        input: redactForDisplay(input),
      } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });

    // Human-in-the-loop gate for destructive or outward-facing tools.
    if (this.needsApproval(tool.descriptor.requiresApproval, ctx)) {
      const verdict = await this.gateOnApproval(tool.descriptor.name, input, ctx);
      if (!verdict.approved) {
        this.audit(ctx, name, input, 'denied', verdict.note, Date.now() - startedAt);
        this.emitResult(name, callId, false, `Not approved: ${verdict.note}`, ctx, Date.now() - startedAt);
        return fail(`"${name}" was not approved`, verdict.note);
      }
    }

    try {
      ctx.signal.throwIfAborted?.();
      const result = await withTimeout(
        tool.execute(input, ctx),
        this.config.limits.toolTimeoutMs,
        `tool ${name}`,
      );

      const durationMs = Date.now() - startedAt;
      this.repos.agents.bumpStat(ctx.agent.id, 'toolCalls');
      this.audit(ctx, name, input, result.ok ? 'ok' : 'error', result.ok ? null : result.summary, durationMs);
      this.emitResult(name, callId, result.ok, result.summary, ctx, durationMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (isCancellation(err)) {
        this.audit(ctx, name, input, 'error', 'cancelled', durationMs);
        throw err;
      }
      const message = errorMessage(err);
      this.logger.warn('tool execution failed', { tool: name, agent: ctx.agent.name, error: message });
      this.audit(ctx, name, input, 'error', message, durationMs);
      this.emitResult(name, callId, false, message, ctx, durationMs);
      // Tool failures are returned to the model rather than thrown: an agent
      // that gets a readable error can often recover, and a thrown error would
      // kill a run over one bad argument.
      return fail(`"${name}" failed`, message);
    }
  }

  // -- authorization --------------------------------------------------------

  /** Returns a denial reason, or null when the call may proceed. */
  private checkAllowed(name: string, ctx: ToolContext): string | null {
    const tool = this.registry.get(name);
    if (!tool) {
      const available = ctx.agent.capabilities.join(', ');
      return `No such tool. The tools you can call are: ${available || '(none)'}`;
    }

    if (!ctx.agent.capabilities.includes(name)) {
      return `Your agent configuration does not grant "${name}". Granted: ${
        ctx.agent.capabilities.join(', ') || '(none)'
      }`;
    }

    if (tool.descriptor.orchestratorOnly && !ctx.agent.isOrchestrator) {
      return `"${name}" is reserved for the orchestrator`;
    }

    if (!this.toolRateLimiter.tryConsume(ctx.agent.id)) {
      return 'Tool call rate limit exceeded for this agent; slow down and consolidate your work';
    }

    return null;
  }

  private needsApproval(toolRequiresApproval: boolean, ctx: ToolContext): boolean {
    return toolRequiresApproval && ctx.workspace.settings.requireApprovalForDangerousTools;
  }

  private async gateOnApproval(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ approved: boolean; note: string }> {
    try {
      return await ctx.services.requestApproval({
        ctx,
        action: `tool:${toolName}`,
        reason: `${ctx.agent.name} wants to run "${toolName}"${
          ctx.task ? ` while working on "${truncate(ctx.task.title, 60)}"` : ''
        }`,
        payload: redactForDisplay(input),
      });
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      return { approved: false, note: `Approval could not be obtained: ${errorMessage(err)}` };
    }
  }

  // -- observability --------------------------------------------------------

  private emitDenied(toolName: string, reason: string, ctx: ToolContext): void {
    this.events.publish(ctx.workspace.id, {
      type: 'TOOL_DENIED',
      actor: ctx.actor,
      payload: { agentId: ctx.agent.id, runId: ctx.run.id, toolName, reason } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });
  }

  private emitResult(
    toolName: string,
    callId: string,
    okResult: boolean,
    summary: string,
    ctx: ToolContext,
    durationMs: number,
  ): void {
    this.events.publish(ctx.workspace.id, {
      type: 'TOOL_RESULT',
      actor: ctx.actor,
      payload: {
        agentId: ctx.agent.id,
        runId: ctx.run.id,
        toolName,
        callId,
        ok: okResult,
        summary: truncate(summary, 300),
        durationMs,
      } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });
  }

  private audit(
    ctx: ToolContext,
    toolName: string,
    input: Record<string, unknown>,
    outcome: ToolAuditEntry['outcome'],
    error: string | null,
    durationMs: number,
  ): void {
    try {
      this.repos.toolAudit.insert({
        id: newId(ID_PREFIXES.toolCall),
        workspaceId: ctx.workspace.id,
        runId: ctx.run.id,
        agentId: ctx.agent.id,
        toolName,
        input: redactForDisplay(input),
        outcome,
        error,
        durationMs,
        createdAt: Date.now(),
      });
    } catch (err) {
      // Never let audit-write failure take down the call it is auditing.
      this.logger.error('tool audit write failed', { error: errorMessage(err) });
    }
  }
}

const SENSITIVE_KEY = /(password|secret|token|api[-_]?key|authorization|credential)/i;

/**
 * Trims tool arguments for storage and display: long bodies are truncated and
 * anything that looks like a credential is masked, so the activity feed and the
 * audit log cannot become an accidental secret store.
 */
export function redactForDisplay(input: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof input === 'string') return truncate(input, 600);
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => redactForDisplay(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactForDisplay(value, depth + 1);
    }
    return out;
  }
  return input;
}
