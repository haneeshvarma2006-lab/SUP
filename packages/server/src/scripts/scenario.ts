/**
 * Runs the competitor-analysis scenario and prints what actually happened.
 *
 *   npm run scenario -w @sup/server
 *
 * Uses an in-memory database and whichever AI provider is configured. With no
 * credentials that is the offline heuristic policy, which is labelled in the
 * output so the provenance of the text is never ambiguous.
 */
import { createApp } from '../app.js';
import type { WorkspaceEvent } from '@sup/shared';

const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';
const CYAN = '[36m';
const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';

async function main(): Promise<void> {
  const app = createApp({ databasePath: ':memory:', logLevel: 'error' });
  app.start();

  const provider = app.providers.default();
  console.log(`${BOLD}SUP — competitor analysis scenario${RESET}`);
  console.log(
    `${DIM}engine: ${provider.displayName}${provider.isLanguageModel ? '' : '  (deterministic, not a language model)'}${RESET}`,
  );
  console.log(
    `${DIM}web search: ${app.search.enabled ? app.search.providerName : 'not configured — the researcher will report the gap'}${RESET}\n`,
  );

  const { user } = app.auth.register({
    email: 'founder@example.com',
    password: 'correct-horse-battery',
    displayName: 'Founder',
  });

  const { workspace, agents } = app.workspaces.createWorkspace({
    name: 'Startup HQ',
    description: 'Where the humans and the agents work together',
    owner: user,
  });

  console.log(`${BOLD}Room:${RESET} ${workspace.name}`);
  for (const agent of agents) {
    console.log(`  ${agent.avatarEmoji} ${agent.name.padEnd(10)} ${DIM}${agent.role}${RESET}`);
  }
  console.log(`  🧑 ${user.displayName.padEnd(10)} ${DIM}Human (owner)${RESET}\n`);

  const agentNames = new Map(agents.map((a) => [a.id, a.name]));
  const started = Date.now();

  app.events.subscribe(workspace.id, (event) => print(event, agentNames, started));

  const objective = app.orchestration.startObjective({
    workspaceId: workspace.id,
    title: 'Build a competitor analysis for my startup',
    description:
      'I am launching a developer-tools startup. I need to know who else is in this space, ' +
      'how they position themselves, and where the gaps are.',
    requestedBy: user,
  });

  console.log(`${BOLD}🧑 Founder:${RESET} "Build a competitor analysis for my startup."\n`);

  await app.events
    .waitFor(
      workspace.id,
      (e) => e.type === 'OBJECTIVE_COMPLETED' && e.objectiveId === objective.task.id,
      120_000,
    )
    .catch(() => console.log(`${RED}The objective did not complete in time.${RESET}`));

  // Let the final status transitions and the episodic write settle.
  await new Promise((r) => setTimeout(r, 250));

  // -- summary ---------------------------------------------------------------

  const tasks = app.repos.tasks.listForObjective(objective.task.id);
  const delegations = app.repos.delegations.listForObjective(objective.task.id);
  const memories = app.repos.memories.listForWorkspace(workspace.id, 100);
  const files = app.repos.files.listForWorkspace(workspace.id, true);

  console.log(`\n${BOLD}── Summary ──${RESET}`);
  console.log(`Tasks:        ${tasks.length} (${tasks.filter((t) => t.status === 'completed').length} completed)`);
  console.log(`Delegations:  ${delegations.filter((d) => d.relation === 'delegate').length} out, ${delegations.filter((d) => d.relation === 'result').length} returned`);
  console.log(`Memory:       ${memories.length} records (${memories.filter((m) => m.scope === 'project').length} project, ${memories.filter((m) => m.scope === 'episodic').length} episodic)`);
  console.log(`Artifacts:    ${files.map((f) => f.path).join(', ') || 'none'}`);
  console.log(`Elapsed:      ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log(`\n${BOLD}── Delegation graph ──${RESET}`);
  for (const edge of delegations) {
    const arrow = edge.relation === 'result' ? '⇠' : '→';
    const colour = edge.relation === 'result' ? GREEN : CYAN;
    console.log(
      `  ${colour}${(agentNames.get(edge.fromAgentId) ?? '?').padEnd(8)} ${arrow} ${(agentNames.get(edge.toAgentId) ?? '?').padEnd(8)}${RESET} ${DIM}${edge.relation}: ${edge.note.slice(0, 60)}${RESET}`,
    );
  }

  const root = app.repos.tasks.byId(objective.task.id);
  console.log(`\n${BOLD}── Final result returned to the human ──${RESET}\n`);
  console.log(root?.result ?? root?.error ?? '(nothing)');

  const report = files.find((f) => f.path.endsWith('.md'));
  if (report) {
    console.log(`\n${BOLD}── Artifact: ${report.path} (${report.size} bytes) ──${RESET}\n`);
    console.log(report.content.slice(0, 1500));
    if (report.content.length > 1500) console.log(`${DIM}… truncated${RESET}`);
  }

  console.log(`\n${BOLD}── Project memory ──${RESET}`);
  for (const memory of memories.filter((m) => m.scope === 'project')) {
    console.log(`  ${YELLOW}[${memory.kind}]${RESET} ${memory.title}`);
  }

  await app.shutdown();
}

function print(event: WorkspaceEvent, agentNames: Map<string, string>, started: number): void {
  const at = `${DIM}${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s${RESET}`;
  const name = (id: string | undefined) => (id ? (agentNames.get(id) ?? id.slice(0, 8)) : '');
  const p = event.payload as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'PLAN_CREATED':
    case 'TASK_DELEGATED': {
      const task = p.task as { title: string; assignee: { name: string } | null };
      console.log(`${at} ${CYAN}→${RESET} ${event.actor.name} delegates to ${BOLD}${task.assignee?.name}${RESET}: ${task.title}`);
      return;
    }
    case 'AGENT_STATUS_CHANGED': {
      const s = p as unknown as { agentId: string; status: string; detail: string };
      if (s.status === 'thinking' || s.status === 'idle') return;
      console.log(`${at}   ${DIM}${name(s.agentId)} is ${s.status}${s.detail ? ` — ${s.detail}` : ''}${RESET}`);
      return;
    }
    case 'TOOL_CALLED': {
      const t = p as unknown as { agentId: string; toolName: string };
      console.log(`${at}   ${DIM}${name(t.agentId)} · ${t.toolName}()${RESET}`);
      return;
    }
    case 'TOOL_DENIED': {
      const t = p as unknown as { agentId: string; toolName: string; reason: string };
      console.log(`${at}   ${RED}${name(t.agentId)} · ${t.toolName}() denied — ${t.reason}${RESET}`);
      return;
    }
    case 'TASK_COMPLETED': {
      const task = p.task as { title: string; assignee: { name: string } | null };
      console.log(`${at} ${GREEN}✓${RESET} ${task.assignee?.name ?? 'someone'} finished: ${task.title}`);
      return;
    }
    case 'TASK_FAILED': {
      const task = p.task as { title: string };
      console.log(`${at} ${RED}✗ failed: ${task.title} — ${String(p.error)}${RESET}`);
      return;
    }
    case 'MEMORY_CREATED': {
      const r = p.record as unknown as { scope: string; title: string };
      if (r.scope === 'episodic') return;
      console.log(`${at}   ${YELLOW}⌾ remembered [${r.scope}] ${r.title}${RESET}`);
      return;
    }
    case 'FILE_CREATED': {
      const f = p.file as unknown as { path: string };
      console.log(`${at} ${GREEN}▣ wrote ${f.path}${RESET}`);
      return;
    }
    case 'AGENT_ERROR':
      console.log(`${at} ${RED}! ${String(p.message)}${RESET}`);
      return;
    case 'OBJECTIVE_COMPLETED':
      console.log(`${at} ${BOLD}${GREEN}✦ objective complete${RESET}`);
      return;
    default:
      return;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
