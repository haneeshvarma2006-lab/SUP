import type { Workspace } from '@sup/shared';
import type { Repositories } from '../db/repos/index.js';

export interface DelegationAttempt {
  workspace: Workspace;
  objectiveId: string;
  fromAgentId: string;
  toAgentId: string;
  depth: number;
  title: string;
}

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Stops agent-to-agent delegation from turning into a loop.
 *
 * Five independent checks, because they fail differently:
 *
 *  1. Self-delegation — trivially a loop.
 *  2. Depth limit — bounds how long a single chain can get.
 *  3. Objective budget — bounds total fan-out even when no single chain is deep.
 *  4. Cycle detection — refuses an edge that would make the delegation graph
 *     cyclic (A→B→C→A), which depth alone does not catch.
 *  5. Duplicate work — refuses re-delegating a title already in flight to the
 *     same agent under this objective, which is how a confused model
 *     ping-pongs the same request.
 *
 * Every refusal returns a reason, which goes back to the model as a tool error
 * so it can adapt rather than retrying blindly.
 */
export class DelegationGuard {
  constructor(private readonly repos: Repositories) {}

  check(attempt: DelegationAttempt): GuardVerdict {
    const { workspace, objectiveId, fromAgentId, toAgentId, depth } = attempt;

    if (fromAgentId === toAgentId) {
      return { allowed: false, reason: 'An agent cannot delegate to itself.' };
    }

    if (depth + 1 > workspace.settings.maxDelegationDepth) {
      return {
        allowed: false,
        reason:
          `Delegation depth limit reached (${workspace.settings.maxDelegationDepth}). ` +
          'Do this work yourself and return the result.',
      };
    }

    const used = this.repos.delegations.countForObjective(objectiveId);
    if (used >= workspace.settings.maxDelegationsPerObjective) {
      return {
        allowed: false,
        reason:
          `This objective has used its entire delegation budget (${workspace.settings.maxDelegationsPerObjective}). ` +
          'Complete the remaining work directly.',
      };
    }

    if (this.wouldCreateCycle(objectiveId, fromAgentId, toAgentId)) {
      return {
        allowed: false,
        reason:
          'That agent is already upstream of you in this objective; delegating to it would create a loop. ' +
          'Wait for its result or do the work yourself.',
      };
    }

    const duplicate = this.findDuplicate(objectiveId, toAgentId, attempt.title);
    if (duplicate) {
      return {
        allowed: false,
        reason:
          `You already delegated "${duplicate}" to that agent under this objective and it has not come back yet. ` +
          'Wait for it rather than delegating again.',
      };
    }

    return { allowed: true };
  }

  /**
   * True when `to` can already reach `from` through existing edges — adding
   * from→to would close the cycle.
   */
  private wouldCreateCycle(objectiveId: string, fromAgentId: string, toAgentId: string): boolean {
    const edges = this.repos.delegations.edgesForObjective(objectiveId);
    if (edges.length === 0) return false;

    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      let targets = adjacency.get(edge.from);
      if (!targets) {
        targets = new Set();
        adjacency.set(edge.from, targets);
      }
      targets.add(edge.to);
    }

    // Breadth-first from `to`; if we can reach `from`, the new edge closes a loop.
    const seen = new Set<string>([toAgentId]);
    const queue = [toAgentId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === fromAgentId) return true;
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** Returns the title of an equivalent in-flight delegation, if one exists. */
  private findDuplicate(objectiveId: string, toAgentId: string, title: string): string | null {
    const normalised = normaliseTitle(title);
    const open = this.repos.tasks
      .listForObjective(objectiveId)
      .filter(
        (task) =>
          task.assignee?.id === toAgentId &&
          !['completed', 'failed', 'cancelled'].includes(task.status),
      );

    for (const task of open) {
      if (normaliseTitle(task.title) === normalised) return task.title;
    }
    return null;
  }

  /** Remaining delegation budget for an objective. */
  remainingBudget(workspace: Workspace, objectiveId: string): number {
    return Math.max(
      0,
      workspace.settings.maxDelegationsPerObjective -
        this.repos.delegations.countForObjective(objectiveId),
    );
  }
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
