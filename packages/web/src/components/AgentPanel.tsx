import { useCallback, useMemo, useState } from 'react';
import { TOOL_RISK_LABEL, type AgentRun, type RunStep } from '@sup/shared';
import { api, type AgentDetail } from '../api/client.js';
import { useAction, useAgent, useAsync, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import {
  AGENT_LABEL,
  AGENT_TONE,
  AgentFace,
  Button,
  Dot,
  Empty,
  ErrorNote,
  Icon,
  TASK_TONE,
  Tag,
  durationText,
  isLive,
  relTime,
  Spinner,
} from './primitives.js';

type Tab = 'now' | 'history' | 'memory' | 'tools' | 'config';

/**
 * The agent inspector.
 *
 * Opening an agent should answer, in order: what is it doing right now, what
 * has it done, what does it know, what is it allowed to touch, and how do I
 * change it. The tabs follow exactly that order — the most time-sensitive
 * question first, configuration last.
 */
export function AgentPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const agent = useAgent(agentId);
  const now = useTicker(10_000);
  const [tab, setTab] = useState<Tab>('now');

  const detail = useAsync<AgentDetail>(
    (signal) => api.agentDetail(agentId, signal),
    // The run pointer changing is the cheapest signal that history moved on.
    [agentId, agent?.currentRunId, agent?.status === 'idle'],
  );

  const pause = useAction(async () => {
    await api.pauseAgent(agentId);
    detail.reload();
  });
  const resume = useAction(async () => {
    await api.resumeAgent(agentId);
    detail.reload();
  });
  const stop = useAction(async () => {
    await api.stopAgent(agentId, `Stopped by ${workspace.viewer.user.displayName}`);
    detail.reload();
  });

  if (!agent) {
    return (
      <aside className="inspector" data-shown="true">
        <div className="inspector__head">
          <span className="grow" style={{ fontWeight: 620 }}>
            Agent
          </span>
          <Button variant="quiet" size="sm" onClick={onClose}>
            <Icon.X size={12} />
          </Button>
        </div>
        <Empty>This agent is no longer in the workspace.</Empty>
      </aside>
    );
  }

  const task = workspace.tasks.find((t) => t.id === agent.currentTaskId);
  const canControl = workspace.viewer.role !== 'viewer';
  const live = isLive(agent);

  return (
    <aside
      className="inspector"
      data-shown="true"
      style={{ ['--tint' as string]: agent.avatarColor }}
      aria-label={`${agent.name} detail`}
    >
      <div className="inspector__head">
        <Icon.Users size={13} className="faint" />
        <span className="grow" style={{ fontWeight: 620, fontSize: 12.5 }}>
          Agent
        </span>
        <Button variant="quiet" size="sm" onClick={onClose} ariaLabel="Close">
          <Icon.X size={12} />
        </Button>
      </div>

      <div className="inspector__hero">
        <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <AgentFace agent={agent} size="xl" />
          <div className="grow">
            <div style={{ fontSize: 16, fontWeight: 660, letterSpacing: '-0.02em' }}>
              {agent.name}
            </div>
            <div className="mid" style={{ fontSize: 12.5 }}>
              {agent.role}
              {agent.isOrchestrator ? ' · leads this team' : ''}
            </div>
            <div className="row" style={{ marginTop: 7, gap: 6 }}>
              <Dot tone={AGENT_TONE[agent.status]} live={live} />
              <span
                style={{ fontSize: 12, fontWeight: 580, color: AGENT_TONE[agent.status] }}
              >
                {agent.paused ? 'Paused' : AGENT_LABEL[agent.status]}
              </span>
              {agent.statusDetail ? (
                <span className="faint trunc" style={{ fontSize: 11.5 }}>
                  {agent.statusDetail}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {agent.tagline ? (
          <div className="mid" style={{ fontSize: 12, marginTop: 11, lineHeight: 1.5 }}>
            {agent.tagline}
          </div>
        ) : null}

        {canControl ? (
          <div className="row" style={{ marginTop: 12 }}>
            {agent.paused ? (
              <Button size="sm" onClick={() => void resume.run()} disabled={resume.pending}>
                <Icon.Play size={11} /> Resume
              </Button>
            ) : (
              <Button size="sm" onClick={() => void pause.run()} disabled={pause.pending}>
                <Icon.Pause size={11} /> Pause
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={() => void stop.run()}
              disabled={stop.pending || !live}
              title={live ? 'Cancel what it is doing right now' : 'Nothing is running'}
            >
              <Icon.Stop size={11} /> Stop
            </Button>
          </div>
        ) : null}

        <ErrorNote>{pause.error ?? resume.error ?? stop.error}</ErrorNote>
      </div>

      <div className="seg">
        {(
          [
            ['now', 'Now'],
            ['history', 'History'],
            ['memory', 'Memory'],
            ['tools', 'Tools'],
            ['config', 'Config'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="seg__btn"
            data-on={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="scroll">
        {tab === 'now' ? (
          <>
            <div className="statgrid">
              <Stat v={agent.stats.tasksCompleted} k="Done" />
              <Stat v={agent.stats.tasksFailed} k="Failed" />
              <Stat v={agent.stats.delegationsMade} k="Delegated" />
              <Stat v={agent.stats.toolCalls} k="Tool calls" />
              <Stat v={agent.stats.feedbackPositive} k="Praised" />
              <Stat v={agent.stats.feedbackNegative} k="Corrected" />
            </div>

            {task ? (
              <div className="pad" style={{ paddingTop: 2 }}>
                <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                  Working on
                </div>
                <div className="card">
                  <div className="row" style={{ marginBottom: 5 }}>
                    <Dot tone={TASK_TONE[task.status]} live />
                    <span style={{ fontWeight: 580, fontSize: 12.5 }}>{task.title}</span>
                  </div>
                  {task.description ? (
                    <div className="mid" style={{ fontSize: 12 }}>
                      {task.description.slice(0, 340)}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <Empty>Not working on anything right now.</Empty>
            )}

            <div className="shead">
              <span>Step trace</span>
              <span className="shead__line" />
            </div>

            {detail.loading ? (
              <div className="pad">
                <Spinner />
              </div>
            ) : (
              <Trace run={detail.data?.runs[0] ?? null} agentId={agentId} />
            )}
          </>
        ) : null}

        {tab === 'history' ? <History detail={detail.data} loading={detail.loading} now={now} /> : null}

        {tab === 'memory' ? (
          <>
            <div className="shead">
              <span>What this agent knows</span>
              <span className="shead__line" />
            </div>
            {(detail.data?.memories ?? []).length === 0 ? (
              <Empty icon={<Icon.Memory size={17} />}>Nothing stored for this agent yet.</Empty>
            ) : (
              (detail.data?.memories ?? []).map((m) => (
                <div className="mem" key={m.id}>
                  <div className="mem__head">
                    {m.pinned ? <Icon.Pin size={11} style={{ color: 'var(--amber)' }} /> : null}
                    <span className="mem__title">{m.title}</span>
                    <Tag tone={m.kind === 'feedback' ? 'amber' : 'neutral'}>{m.kind}</Tag>
                  </div>
                  <div className="mem__text mem__text--clamp">{m.content}</div>
                  <div className="mem__foot">
                    {m.scope} · used {m.useCount}× · {relTime(m.updatedAt, now)}
                  </div>
                </div>
              ))
            )}
          </>
        ) : null}

        {tab === 'tools' ? (
          <>
            <div className="shead">
              <span>Permitted tools</span>
              <span className="shead__line" />
            </div>
            {(detail.data?.capabilities ?? []).map((tool) => (
              <div className="mem" key={tool.name}>
                <div className="mem__head">
                  <Icon.Tool size={11} className="faint" />
                  <span className="mem__title mono">{tool.name}</span>
                  <Tag
                    tone={tool.risk === 'dangerous' ? 'rose' : tool.risk === 'guarded' ? 'amber' : 'mint'}
                  >
                    {TOOL_RISK_LABEL[tool.risk]}
                  </Tag>
                </div>
                <div className="mem__text mem__text--clamp">{tool.description}</div>
              </div>
            ))}
            <div className="pad faint" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
              Anything not listed is refused at execution time, even if the model asks for it.
            </div>
          </>
        ) : null}

        {tab === 'config' ? <Config agentId={agentId} onSaved={detail.reload} /> : null}
      </div>
    </aside>
  );
}

function Stat({ v, k }: { v: number; k: string }) {
  return (
    <div className="stat">
      <div className="stat__v">{v}</div>
      <div className="stat__k">{k}</div>
    </div>
  );
}

/**
 * The live step trace.
 *
 * These are the run's persisted steps — every tool the agent called, with the
 * real duration and outcome. It is an activity record, not a reconstruction of
 * the model's internal reasoning, and it is labelled that way.
 */
function Trace({ run, agentId }: { run: AgentRun | null; agentId: string }) {
  const steps = useAsync<RunStep[]>(
    async () => {
      if (!run) return [];
      return (await api.agentRun(agentId, run.id)).run.steps;
    },
    [run?.id, run?.status],
  );

  if (!run) return <Empty>No runs yet.</Empty>;
  if (steps.loading) {
    return (
      <div className="pad">
        <Spinner />
      </div>
    );
  }

  const list = steps.data ?? [];
  if (list.length === 0) return <Empty>This run has not produced any steps yet.</Empty>;

  return (
    <div className="pad" style={{ paddingTop: 2 }}>
      <div className="trace">
        {list.map((step) => (
          <div key={step.id} className="trace__item" data-ok={step.ok}>
            {step.toolName ? (
              <div className="row" style={{ gap: 6, marginBottom: 1 }}>
                <span className="mono" style={{ color: 'var(--ink-low)' }}>
                  {step.toolName}
                </span>
                {step.durationMs > 0 ? (
                  <span className="faint" style={{ fontSize: 10 }}>
                    {durationText(step.durationMs)}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="mid" style={{ fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {step.summary.slice(0, 520)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function History({
  detail,
  loading,
  now,
}: {
  detail: AgentDetail | null;
  loading: boolean;
  now: number;
}) {
  if (loading) {
    return (
      <div className="pad">
        <Spinner />
      </div>
    );
  }

  const runs = detail?.runs ?? [];
  if (runs.length === 0) return <Empty icon={<Icon.Clock size={17} />}>No history yet.</Empty>;

  return (
    <>
      <div className="shead">
        <span>Recent runs</span>
        <span className="shead__line" />
      </div>

      {runs.map((run) => (
        <div className="mem" key={run.id}>
          <div className="mem__head">
            <span className="mem__title">{run.result?.slice(0, 74) ?? run.error ?? 'Run'}</span>
            <Tag
              tone={
                run.status === 'succeeded'
                  ? 'mint'
                  : run.status === 'failed'
                    ? 'rose'
                    : run.status === 'cancelled'
                      ? 'neutral'
                      : 'pulse'
              }
            >
              {run.status}
            </Tag>
          </div>
          <div className="mem__foot">
            {relTime(run.startedAt, now)} ·{' '}
            {run.endedAt ? durationText(run.endedAt - run.startedAt) : 'running'} ·{' '}
            {run.usage.toolCalls} tools · {run.usage.modelCalls} model calls
            {run.usage.provider ? ` · ${run.usage.provider}` : ''}
          </div>
        </div>
      ))}

      <div className="shead">
        <span>Recent tool calls</span>
        <span className="shead__line" />
      </div>

      {(detail?.recentTools ?? []).slice(0, 25).map((entry) => (
        <div className="xchg" key={entry.id}>
          <Icon.Tool size={11} className="faint" />
          <span className="mono grow trunc">{entry.toolName}</span>
          <Tag tone={entry.outcome === 'ok' ? 'mint' : entry.outcome === 'denied' ? 'rose' : 'amber'}>
            {entry.outcome}
          </Tag>
          <span className="faint" style={{ fontSize: 10.5 }}>
            {relTime(entry.createdAt, now)}
          </span>
        </div>
      ))}
    </>
  );
}

/** Live editing of identity, instructions and tool grants. */
function Config({ agentId, onSaved }: { agentId: string; onSaved: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const agent = useAgent(agentId);

  const [instructions, setInstructions] = useState(agent?.systemInstructions ?? '');
  const [temperature, setTemperature] = useState(agent?.temperature ?? 0.3);
  const [caps, setCaps] = useState<string[]>(agent?.capabilities ?? []);
  const [dirty, setDirty] = useState(false);

  const byCategory = useMemo(() => {
    const groups = new Map<string, typeof workspace.tools>();
    for (const tool of workspace.tools) {
      const list = groups.get(tool.category) ?? [];
      list.push(tool);
      groups.set(tool.category, list);
    }
    return [...groups.entries()];
  }, [workspace.tools]);

  const save = useAction(async () => {
    await api.updateAgent(agentId, { systemInstructions: instructions, temperature, capabilities: caps });
    setDirty(false);
    onSaved();
  });

  const toggle = useCallback((name: string) => {
    setDirty(true);
    setCaps((cur) => (cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name]));
  }, []);

  if (!agent) return null;
  const canEdit = workspace.viewer.role !== 'viewer';

  return (
    <div className="pad">
      <div className="field">
        <label htmlFor="ag-instr">System instructions</label>
        <textarea
          id="ag-instr"
          className="textarea"
          style={{ minHeight: 210, fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6 }}
          value={instructions}
          disabled={!canEdit}
          onChange={(e) => {
            setInstructions(e.target.value);
            setDirty(true);
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="ag-temp">Temperature — {temperature.toFixed(2)}</label>
        <input
          id="ag-temp"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={temperature}
          disabled={!canEdit}
          onChange={(e) => {
            setTemperature(Number(e.target.value));
            setDirty(true);
          }}
        />
      </div>

      <div className="field">
        <label>Tool grants</label>
        <div className="faint" style={{ fontSize: 11, marginBottom: 7 }}>
          Changes take effect on this agent's next run.
        </div>
        {byCategory.map(([category, tools]) => (
          <div key={category} style={{ marginBottom: 10 }}>
            <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
              {category}
            </div>
            {tools.map((tool) => (
              <label
                key={tool.name}
                className="row"
                style={{ fontSize: 12, padding: '3px 0', cursor: canEdit ? 'pointer' : 'default' }}
              >
                <input
                  type="checkbox"
                  checked={caps.includes(tool.name)}
                  disabled={!canEdit}
                  onChange={() => toggle(tool.name)}
                />
                <span className="mono grow">{tool.name}</span>
                {tool.risk === 'dangerous' ? <Tag tone="rose">approval</Tag> : null}
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="faint" style={{ fontSize: 11, marginBottom: 11 }}>
        Model: <span className="mono">{agent.model}</span>
      </div>

      {canEdit ? (
        <Button
          variant="primary"
          onClick={() => void save.run()}
          disabled={!dirty || save.pending}
          style={{ width: '100%' }}
        >
          {save.pending ? <Spinner /> : dirty ? 'Save changes' : 'Saved'}
        </Button>
      ) : null}

      <ErrorNote>{save.error}</ErrorNote>
    </div>
  );
}
