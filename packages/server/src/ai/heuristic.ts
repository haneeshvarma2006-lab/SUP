import { createHash } from 'node:crypto';
import {
  collectToolUses,
  estimateTokens,
  type AIProvider,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResponse,
  type ModelMessage,
  type ToolResultBlock,
} from './provider.js';

/**
 * Deterministic, offline provider.
 *
 * This is NOT a language model and it is labelled as such everywhere it
 * surfaces in the UI. It is a rule-based policy that reads the same request the
 * real providers get — role, task, roster, prior tool results — and decides
 * which tool to call next and what to write.
 *
 * It exists for two reasons:
 *  1. The platform must be runnable and testable end to end without network
 *     access or an API key. Every other layer (runtime, orchestration, memory,
 *     tools, events, concurrency) is exercised for real against it.
 *  2. Tests need a model whose output does not drift between runs.
 *
 * It composes its output from actual context — an analyst's write-up is derived
 * from the researcher's real tool results, not from a canned string — but it
 * does not reason, and its prose quality is what a template can manage.
 * Set ANTHROPIC_API_KEY to run the same workspace on a real model.
 */
export class HeuristicProvider implements AIProvider {
  readonly name = 'heuristic';
  readonly displayName = 'Heuristic (offline, not an LLM)';
  readonly supportsTools = true;
  readonly isLanguageModel = false;
  readonly defaultModel = 'heuristic-v1';

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    if (signal?.aborted) throw new Error('aborted');

    const context = readContext(request);
    const content = this.decide(request, context);

    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: estimateTokens(request.system) + estimateTokens(context.transcript),
        outputTokens: estimateTokens(JSON.stringify(content)),
      },
      model: this.defaultModel,
      provider: this.name,
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'offline heuristic policy; no model calls are made' };
  }

  private decide(request: GenerateRequest, ctx: PolicyContext): ContentBlock[] {
    const available = new Set(request.tools.map((t) => t.name));
    const role = ctx.role.toLowerCase();

    // Always ground in memory once, if the agent is allowed to.
    if (available.has('memory_search') && !ctx.called.has('memory_search')) {
      return [
        text(`Checking what the team already knows about "${ctx.taskTitle}" before starting.`),
        toolUse(ctx, 'memory_search', {
          query: ctx.taskTitle || ctx.objective,
          limit: 6,
        }),
      ];
    }

    if (role.includes('orchestrat')) return this.orchestrate(ctx, available);
    if (role.includes('research')) return this.research(ctx, available);
    if (role.includes('analy')) return this.analyse(ctx, available);
    if (role.includes('review')) return this.review(ctx, available);
    if (role.includes('writ')) return this.write(ctx, available);

    return this.generic(ctx, available);
  }

  // -- role policies --------------------------------------------------------

  private orchestrate(ctx: PolicyContext, available: Set<string>): ContentBlock[] {
    const plan = buildPlan(ctx);
    const delegated = ctx.toolInputs.get('delegate_task') ?? [];

    if (available.has('delegate_task') && delegated.length < plan.length) {
      const step = plan[delegated.length]!;
      const previous = delegated.length > 0 ? ctx.delegatedTaskIds : [];
      return [
        text(`Assigning step ${delegated.length + 1} of ${plan.length}: ${step.title}.`),
        toolUse(ctx, 'delegate_task', {
          agent: step.agent,
          title: step.title,
          description: step.description,
          depends_on: step.dependsOnPrevious && previous.length > 0 ? [previous[previous.length - 1]] : [],
        }),
      ];
    }

    // Tool results arrive as JSON envelopes. Unwrap them: what the human wants
    // is each teammate's deliverable, not the transport around it.
    const returned = ctx.resultsByTool('delegate_task').map(parseDelegationResult);
    const objectiveTitle = ctx.objective.split('\n')[0]!.trim();

    const summary = [
      `## ${objectiveTitle}`,
      '',
      `Delivered by ${plan.length} teammate${plan.length === 1 ? '' : 's'} in this workspace.`,
      '',
      ...plan.map((step, i) => `${i + 1}. **${step.agent}** — ${step.title}`),
      '',
      '---',
      '',
    ]
      .concat(
        returned.length > 0
          ? returned.map((entry) =>
              // Trailing blank line: the outer join uses a single newline, so
              // without it consecutive sections run together.
              [`### ${entry.agent}`, '', condense(entry.result, 2500), ''].join('\n'),
            )
          : ['### Outcome', '', 'No delegated results were returned.'],
      )
      .join('\n');

    // The last step in the pipeline produced the actual artifact, so its output
    // is what the human should read first.
    const finalDeliverable = returned.at(-1);

    return [
      text('All delegated work is back. Reconciling and closing out the objective.'),
      toolUse(ctx, 'return_result', {
        summary: finalDeliverable
          ? `${objectiveTitle} — completed across ${plan.length} delegated tasks; final output from ${finalDeliverable.agent}.`
          : `Completed "${objectiveTitle}" across ${plan.length} delegated tasks.`,
        result: summary,
      }),
    ];
  }

  private research(ctx: PolicyContext, available: Set<string>): ContentBlock[] {
    if (available.has('web_search') && !ctx.called.has('web_search')) {
      return [
        text(`Searching for source material on "${ctx.subject}".`),
        toolUse(ctx, 'web_search', { query: ctx.subject, limit: 5 }),
      ];
    }

    const findings = ctx.resultsByTool('web_search');
    const body = renderFindings(ctx, findings);

    if (available.has('memory_write') && !ctx.called.has('memory_write')) {
      return [
        text('Recording the durable findings so the team does not re-research this.'),
        toolUse(ctx, 'memory_write', {
          scope: 'project',
          kind: 'fact',
          title: `Research: ${truncateWords(ctx.subject, 8)}`,
          content: condense(body, 1200),
          importance: 0.7,
          tags: ['research', slugWord(ctx.subject)],
        }),
      ];
    }

    return [
      text('Research complete.'),
      toolUse(ctx, 'return_result', {
        summary: `Gathered source material on ${ctx.subject}.`,
        result: body,
      }),
    ];
  }

  private analyse(ctx: PolicyContext, available: Set<string>): ContentBlock[] {
    const inputs = ctx.upstreamText();
    const body = renderAnalysis(ctx, inputs);

    if (available.has('memory_write') && !ctx.called.has('memory_write')) {
      return [
        text('Capturing the analytical conclusion for the project record.'),
        toolUse(ctx, 'memory_write', {
          scope: 'project',
          kind: 'decision',
          title: `Analysis: ${truncateWords(ctx.subject, 8)}`,
          content: condense(body, 1200),
          importance: 0.75,
          tags: ['analysis', slugWord(ctx.subject)],
        }),
      ];
    }

    return [
      text('Analysis complete.'),
      toolUse(ctx, 'return_result', {
        summary: `Analysed the research on ${ctx.subject}.`,
        result: body,
      }),
    ];
  }

  private review(ctx: PolicyContext, _available: Set<string>): ContentBlock[] {
    const inputs = ctx.upstreamText();
    const issues = findReviewIssues(inputs);
    const verdict = issues.length === 0 ? 'APPROVED' : 'CHANGES_REQUESTED';

    const body = [
      verdict,
      '',
      `Reviewed ${inputs.length} upstream input${inputs.length === 1 ? '' : 's'} against the brief: "${ctx.taskTitle}".`,
      '',
      issues.length === 0
        ? 'Checks passed: the work addresses the brief, the conclusions trace to the stated inputs, and no fabricated specifics were detected.'
        : ['Issues found:', ...issues.map((issue, i) => `${i + 1}. ${issue}`)].join('\n'),
    ].join('\n');

    return [
      text(`Review verdict: ${verdict}.`),
      toolUse(ctx, 'return_result', {
        summary: `${verdict} — ${issues.length} issue${issues.length === 1 ? '' : 's'} raised.`,
        result: body,
      }),
    ];
  }

  private write(ctx: PolicyContext, available: Set<string>): ContentBlock[] {
    const inputs = ctx.upstreamText();
    const document = renderReport(ctx, inputs);
    const path = `reports/${slugWord(ctx.objective || ctx.taskTitle)}.md`;

    if (available.has('file_write') && !ctx.called.has('file_write')) {
      return [
        text(`Writing the final document to ${path}.`),
        toolUse(ctx, 'file_write', { path, content: document }),
      ];
    }

    return [
      text('Document written.'),
      toolUse(ctx, 'return_result', {
        summary: `Final report written to ${path}.`,
        result: document,
        artifact_path: path,
      }),
    ];
  }

  private generic(ctx: PolicyContext, available: Set<string>): ContentBlock[] {
    const inputs = ctx.upstreamText();
    const body = [
      `## ${ctx.taskTitle}`,
      '',
      ctx.taskDescription || 'No further description was provided.',
      '',
      inputs.length > 0 ? '### Inputs used' : '',
      ...inputs.map((i) => `- ${condense(i, 300)}`),
    ]
      .filter(Boolean)
      .join('\n');

    if (available.has('memory_write') && !ctx.called.has('memory_write')) {
      return [
        text('Recording the outcome.'),
        toolUse(ctx, 'memory_write', {
          scope: 'project',
          kind: 'fact',
          title: truncateWords(ctx.taskTitle, 10),
          content: condense(body, 900),
          importance: 0.5,
          tags: [slugWord(ctx.role)],
        }),
      ];
    }

    return [
      text('Task complete.'),
      toolUse(ctx, 'return_result', { summary: ctx.taskTitle, result: body }),
    ];
  }
}

// ---------------------------------------------------------------------------
// Context extraction — everything the policy decides on comes from the request
// ---------------------------------------------------------------------------

interface RosterEntry {
  name: string;
  role: string;
}

interface PolicyContext {
  role: string;
  agentName: string;
  objective: string;
  taskTitle: string;
  taskDescription: string;
  subject: string;
  roster: RosterEntry[];
  /** Tool names already invoked in this run. */
  called: Set<string>;
  /** Inputs passed to each tool, in call order. */
  toolInputs: Map<string, Array<Record<string, unknown>>>;
  /** Text of every tool result seen so far. */
  results: Array<{ tool: string; text: string; isError: boolean }>;
  delegatedTaskIds: string[];
  /** Results of the tasks this task depends on, supplied by the runtime. */
  upstream: Array<{ title?: string; author?: string; result?: string }>;
  transcript: string;
  seed: number;
  resultsByTool(tool: string): string[];
  /** Result text that came from other agents' work, i.e. real upstream inputs. */
  upstreamText(): string[];
}

function readContext(request: GenerateRequest): PolicyContext {
  const meta = (request.metadata ?? {}) as Record<string, unknown>;
  const role = str(meta.role) || 'Agent';
  const agentName = str(meta.agentName) || 'Agent';
  const objective = str(meta.objective);
  const taskTitle = str(meta.taskTitle);
  const taskDescription = str(meta.taskDescription);
  const roster = Array.isArray(meta.roster) ? (meta.roster as RosterEntry[]) : [];
  const upstream = Array.isArray(meta.upstream)
    ? (meta.upstream as Array<{ title?: string; author?: string; result?: string }>)
    : [];

  const called = new Set<string>();
  const toolInputs = new Map<string, Array<Record<string, unknown>>>();
  const results: Array<{ tool: string; text: string; isError: boolean }> = [];
  const delegatedTaskIds: string[] = [];
  const pendingByUseId = new Map<string, string>();

  for (const message of request.messages) {
    for (const use of collectToolUses(message.content)) {
      called.add(use.name);
      const list = toolInputs.get(use.name) ?? [];
      list.push(use.input);
      toolInputs.set(use.name, list);
      pendingByUseId.set(use.id, use.name);
    }
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const result = block as ToolResultBlock;
      const tool = pendingByUseId.get(result.toolUseId) ?? 'unknown';
      results.push({ tool, text: result.content, isError: result.isError });
      const taskId = /"task_?id"\s*:\s*"([^"]+)"/.exec(result.content)?.[1];
      if (tool === 'delegate_task' && taskId) delegatedTaskIds.push(taskId);
    }
  }

  const transcript = request.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('\n');

  // The subject is what the agent is working on, so prefer the concrete task
  // title over the whole objective blob (which carries the human's full brief).
  const subject = deriveSubject(taskTitle || objective || taskDescription);

  return {
    role,
    agentName,
    objective: objective || taskTitle,
    taskTitle: taskTitle || objective,
    taskDescription,
    subject,
    roster,
    called,
    toolInputs,
    results,
    delegatedTaskIds,
    upstream,
    transcript,
    seed: seedFrom(`${agentName}:${taskTitle}`),
    resultsByTool(tool: string) {
      return results.filter((r) => r.tool === tool && !r.isError).map((r) => r.text);
    },
    upstreamText() {
      // The results of the tasks this one depends on are the real input: they
      // are what the previous agent in the pipeline actually produced.
      const fromDependencies = upstream
        .map((u) => str(u.result))
        .filter((text) => text.length > 0);
      if (fromDependencies.length > 0) return fromDependencies;

      // Otherwise fall back to what this run itself retrieved. The agent's own
      // bookkeeping calls are excluded — echoing a file_write receipt back into
      // a report is not input, it is noise.
      const bookkeeping = new Set([
        'memory_write',
        'memory_search',
        'update_task',
        'send_message',
        'broadcast_event',
        'file_write',
        'generate_document',
        'list_tasks',
      ]);
      const relevant = results.filter((r) => !r.isError && !bookkeeping.has(r.tool));
      const fromContext = relevant.map((r) => r.text);
      if (fromContext.length > 0) return fromContext;

      return taskDescription ? [taskDescription] : [];
    },
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Rendering helpers — deterministic, derived from real inputs
// ---------------------------------------------------------------------------

interface PlanStep {
  agent: string;
  title: string;
  description: string;
  dependsOnPrevious: boolean;
}

/**
 * Builds a plan from the roster actually present in the workspace. Roles the
 * workspace does not have are simply skipped, so a custom roster still plans.
 */
function buildPlan(ctx: PolicyContext): PlanStep[] {
  const subject = ctx.subject;
  const pipeline: Array<{ match: RegExp; title: string; description: string }> = [
    {
      match: /research/i,
      title: `Research ${subject}`,
      description: `Gather source material on ${subject}. Produce one entry per subject with what it is, why it matters, and where the claim came from. Mark verified facts separately from inference.`,
    },
    {
      match: /analy/i,
      title: `Analyse the research on ${subject}`,
      description: `Take the research findings and turn them into structured judgement: comparison along discriminating dimensions, ranked conclusions, explicit trade-offs, and a short "so what".`,
    },
    {
      match: /review|qa|critic/i,
      title: `Review the analysis of ${subject}`,
      description: `Check the analysis against the original brief. Look for unsupported claims, fabricated specifics, contradictions and missing pieces. Return APPROVED or CHANGES_REQUESTED with specifics.`,
    },
    {
      match: /writ|editor|report/i,
      title: `Write the final report on ${subject}`,
      description: `Produce the deliverable from the reviewed analysis. Executive summary, substance in sections, explicit recommendations, and a note on gaps. Write it to a file.`,
    },
    {
      match: /cod(e|er)|engineer|develop/i,
      title: `Implement the changes for ${subject}`,
      description: `Implement and verify the change. Report what you ran and what it produced.`,
    },
    {
      match: /debug/i,
      title: `Diagnose the failure in ${subject}`,
      description: `Reproduce the failure, isolate it, and state the root cause with evidence.`,
    },
    {
      match: /plan/i,
      title: `Sequence the work for ${subject}`,
      description: `Produce an ordered, dependency-aware plan with named deliverables and risks.`,
    },
  ];

  const steps: PlanStep[] = [];
  for (const stage of pipeline) {
    const agent = ctx.roster.find((r) => stage.match.test(r.role) || stage.match.test(r.name));
    if (!agent) continue;
    steps.push({
      agent: agent.name,
      title: stage.title,
      description: stage.description,
      dependsOnPrevious: steps.length > 0,
    });
  }

  if (steps.length === 0 && ctx.roster.length > 0) {
    const agent = ctx.roster[0]!;
    steps.push({
      agent: agent.name,
      title: ctx.objective,
      description: ctx.taskDescription || ctx.objective,
      dependsOnPrevious: false,
    });
  }

  return steps;
}

function renderFindings(ctx: PolicyContext, rawResults: string[]): string {
  const items = rawResults.flatMap(parseSearchItems);
  const lines: string[] = [`## Research findings: ${ctx.subject}`, ''];

  if (items.length === 0) {
    lines.push(
      'No external search results were available in this environment, so there is nothing verified to report.',
      '',
      'This is a genuine gap, not a summary of absent sources. Configure a search provider',
      '(SEARCH_PROVIDER + SEARCH_API_KEY) to give this agent real material to work from.',
      '',
      `Scope that was requested: ${ctx.taskDescription || ctx.taskTitle}`,
    );
    return lines.join('\n');
  }

  lines.push(`${items.length} source${items.length === 1 ? '' : 's'} retrieved.`, '');
  for (const [i, item] of items.entries()) {
    lines.push(`### ${i + 1}. ${item.title}`);
    if (item.url) lines.push(`Source: ${item.url}`);
    lines.push('', item.snippet || '(no extract available)', '');
  }
  lines.push('### Confidence', '');
  lines.push(
    'Every entry above is quoted from a retrieved source. Nothing here has been independently corroborated.',
  );
  return lines.join('\n');
}

function renderAnalysis(ctx: PolicyContext, inputs: string[]): string {
  const items = inputs.flatMap(parseSearchItems);
  const inputText = inputs.join('\n\n').trim();
  const lines: string[] = [`## Analysis: ${ctx.subject}`, ''];

  if (items.length === 0) {
    lines.push(
      inputText
        ? 'Working from the inputs supplied by the team:'
        : 'No usable input reached this analysis.',
      '',
      inputText ? condense(inputText, 1500) : 'The upstream task produced nothing to analyse.',
      '',
      '### Judgement',
      '',
      inputText
        ? 'The material above is thin enough that any ranking would be inference rather than analysis. The honest conclusion is that the research step needs to produce sourced material before a comparison is meaningful.'
        : 'No conclusion can be drawn. Re-run the upstream research step.',
    );
    return lines.join('\n');
  }

  lines.push(`### Comparison (${items.length} subject${items.length === 1 ? '' : 's'})`, '');
  lines.push('| # | Subject | What the source says | Evidence |');
  lines.push('| - | ------- | -------------------- | -------- |');
  for (const [i, item] of items.entries()) {
    lines.push(
      `| ${i + 1} | ${escapeCell(item.title)} | ${escapeCell(condense(item.snippet, 160))} | ${
        item.url ? 'sourced' : 'unsourced'
      } |`,
    );
  }

  const sourced = items.filter((i) => i.url).length;
  lines.push(
    '',
    '### Findings',
    '',
    `- ${sourced} of ${items.length} entries carry a source; the remainder are unverified and should be treated as leads.`,
    `- The strongest-documented subject is "${items[0]!.title}", which is the one to benchmark against first.`,
    items.length > 2
      ? `- Coverage is broad enough (${items.length} subjects) to see the shape of the space, but not deep enough for pricing or positioning claims.`
      : '- Coverage is too narrow to generalise from; treat this as a first pass.',
    '',
    '### So what',
    '',
    'Use the sourced entries to frame the landscape, and commission a second research pass on anything that has to withstand scrutiny.',
  );
  return lines.join('\n');
}

function renderReport(ctx: PolicyContext, inputs: string[]): string {
  const combined = inputs.join('\n\n').trim();
  const items = inputs.flatMap(parseSearchItems);

  return [
    `# ${titleCase(ctx.objective || ctx.taskTitle)}`,
    '',
    `Prepared by ${ctx.agentName} with the agent team in this workspace.`,
    '',
    '## Executive summary',
    '',
    items.length > 0
      ? `This report covers ${items.length} subject${items.length === 1 ? '' : 's'} identified during research and carried through analysis and review. ${
          items.filter((i) => i.url).length
        } of them are backed by a retrieved source.`
      : 'The upstream steps did not produce sourced material, so this report records what was attempted and where the gap is rather than presenting unsupported conclusions.',
    '',
    '## Detail',
    '',
    combined ? condense(combined, 4000) : '_No upstream content was available._',
    '',
    '## Recommendations',
    '',
    items.length > 0
      ? [
          '1. Treat the sourced entries as the working landscape and validate them directly.',
          '2. Commission a deeper pass on anything that will inform a pricing or positioning decision.',
          '3. Re-run this workflow once a search provider is configured for wider coverage.',
        ].join('\n')
      : '1. Configure a search provider and re-run the objective so the research step has real material.',
    '',
    '## Gaps and uncertainty',
    '',
    'Nothing in this report has been independently corroborated beyond the sources quoted above.',
  ].join('\n');
}

function findReviewIssues(inputs: string[]): string[] {
  const issues: string[] = [];
  const combined = inputs.join('\n').trim();

  if (combined.length === 0) {
    issues.push('No upstream work was supplied to review.');
    return issues;
  }
  if (combined.length < 200) {
    issues.push(
      'The submitted work is too short to address the brief; it reads as a stub rather than a deliverable.',
    );
  }
  if (/\bno (external )?search results\b|nothing verified|no usable input/i.test(combined)) {
    issues.push(
      'The analysis is built on an acknowledged empty research step. The gap is stated honestly, but the conclusion cannot be relied on until research produces sourced material.',
    );
  }
  if (/\blorem ipsum\b|\bTODO\b|\bTBD\b|\bplaceholder\b/i.test(combined)) {
    issues.push('The work contains placeholder text that must be resolved before it ships.');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Small parsing/formatting utilities
// ---------------------------------------------------------------------------

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Pulls structured items out of a tool result. Tool results are JSON when they
 * come from our own tools, so this reads them properly rather than regexing
 * prose.
 */
function parseSearchItems(raw: string): SearchItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const container = parsed as { results?: unknown; items?: unknown };
    const list = Array.isArray(container?.results)
      ? container.results
      : Array.isArray(container?.items)
        ? container.items
        : Array.isArray(parsed)
          ? parsed
          : null;
    if (!list) return [];
    return list
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        title: str(entry.title) || str(entry.name) || 'Untitled',
        url: str(entry.url) || str(entry.link),
        snippet: str(entry.snippet) || str(entry.description) || str(entry.content),
      }))
      .filter((item) => item.title !== 'Untitled' || item.snippet.length > 0);
  } catch {
    return [];
  }
}

/**
 * Unwraps the JSON envelope `delegate_task` returns, so a teammate's prose is
 * rendered as prose. Falls back to the raw text when the shape is unexpected --
 * showing something is better than showing nothing.
 */
function parseDelegationResult(raw: string): { agent: string; result: string } {
  try {
    const parsed = JSON.parse(raw) as { agent?: unknown; result?: unknown };
    const result = str(parsed.result);
    if (result) return { agent: str(parsed.agent) || 'A teammate', result };
  } catch {
    // Not JSON; treat the whole thing as the result.
  }
  return { agent: 'A teammate', result: raw };
}

function deriveSubject(text: string): string {
  const cleaned = text
    .replace(/^(build|create|make|do|produce|write|prepare|run)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\s+for\s+my\s+/i, ' for ')
    .trim();
  return truncateWords(cleaned || 'the objective', 12);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function condense(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return `${(lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trim()}\n\n_(truncated)_`;
}

/**
 * Title-cases a heading. Long text is left alone: shouting a whole paragraph in
 * title case is worse than leaving the author's casing intact.
 */
function titleCase(text: string): string {
  const firstLine = text.split('\n')[0]!.trim();
  if (firstLine.length > 80) return firstLine;
  const minor = new Set(['a', 'an', 'the', 'for', 'and', 'or', 'of', 'in', 'on', 'to', 'my', 'at']);
  return firstLine
    .split(/\s+/)
    .map((word, i) =>
      i > 0 && minor.has(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

function slugWord(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-') || 'item'
  );
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function seedFrom(text: string): number {
  return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

let toolUseCounter = 0;

function toolUse(ctx: PolicyContext, name: string, input: Record<string, unknown>): ContentBlock {
  toolUseCounter += 1;
  return {
    type: 'tool_use',
    id: `heur_${ctx.seed.toString(36)}_${toolUseCounter.toString(36)}`,
    name,
    input,
  };
}

/** Exposed for tests that assert the policy reads context rather than guessing. */
export const __testing = { readContext, buildPlan, parseSearchItems, findReviewIssues };

export type { ModelMessage };
