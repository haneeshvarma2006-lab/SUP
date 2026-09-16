import { useCallback, useMemo, useState } from 'react';
import { TOOL_RISK_LABEL, type AgentRun, type RunStep } from '@sup/shared';
import { api, type AgentDetail } from '../api/client.js';
import {
  useAction,
  useAgent,
  useAsync,
  useTicker,
  useWorkspaceOrThrow,
} from '../state/hooks.js';
import {
  AGENT_STATUS_COLOR,
  AGENT_STATUS_LABEL,
  AgentAvatar,
  Badge,
  Empty,
  ErrorText,
  PanelHeader,
  Spinner,
  StatusDot,
  TASK_STATUS_COLOR,
  duration,
  relativeTime,
} from './primitives.js';

type Tab = 'now' | 'activity' | 'memory' | 'tools' | 'config';

/**
 * The agent inspector.
 *
 * Opens on click from the participants rail. Everything a human needs to
 * understand and steer one agent: what it is doing this second, what it did
 * before, what it knows, what it is allowed to touch, and the controls to
 * pause, stop or reconfigure it.
 */
export function AgentPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const agent = useAgent(agentId);
  const now = useTicker(10_000);
  const [tab, setTab] = useState<Tab>('now');

  const detail = useAsync<AgentDetail>(
    (signal) => api.agentDetail(agentId, signal),
    // Refetch when the agent's run pointer changes — that is the cheapest
    // signal that its history has something new in it.
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
      <div className="inspector">
        <PanelHeader title="Agent">
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </PanelHeader>
        <Empty>This agent is no longer in the workspace.</Empty>
      </div>
    );
  }

  const currentTask = workspace.tasks.find((t) => t.id === agent.currentTaskId);
  const canControl = workspace.viewer.role !== 'viewer';
  const live = agent.status !== 'idle' && agent.status !== 'paused';

  return (
    <div className="inspector" style={{ ['--avatar-color' as string]: agent.avatarColor }}>
      <PanelHeader title="Agent">
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </PanelHeader>

      <div className="inspector-hero">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <AgentAvatar agent={agent} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{agent.name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {agent.role}
              {agent.isOrchestrator ? ' · leads this workspace' : ''}
            </div>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <StatusDot status={agent.status} />
              <span style={{ fontSize: 12.5, color: AGENT_STATUS_COLOR[agent.status], fontWeight: 600 }}>
                {agent.paused ? 'Paused' : AGENT_STATUS_LABEL[agent.status]}
              </span>
              {agent.statusDetail ? (
                <span className="dim truncate" style={{ fontSize: 12 }}>
                  — {agent.statusDetail}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {agent.tagline ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            {agent.tagline}
          </div>
        ) : null}

        {canControl ? (
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            {agent.paused ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => void resume.run()}
                disabled={resume.pending}
              >
                ▶ Resume
              </button>
            ) : (
              <button
                type="button"
                className="btn sm"
                onClick={() => void pause.run()}
                disabled={pause.pending}
              >
                ⏸ Pause
              </button>
            )}
            <button
              type="button"
              className="btn danger sm"
              onClick={() => void stop.run()}
              disabled={stop.pending || !live}
              title={live ? 'Cancel whatever it is doing right now' : 'Nothing is running'}
            >
              ■ Stop
            </button>
          </div>
        ) : null}

        <ErrorText>{pause.error ?? resume.error ?? stop.error}</ErrorText>
      </div>

      <div className="tabs">
        {(
          [
            ['now', 'Now'],
            ['activity', 'History'],
            ['memory', 'Memory'],
            ['tools', 'Capabilities'],
            ['config', 'Config'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="column-scroll">
        {tab === 'now' ? (
          <>
            <div className="stat-grid">
              <Stat label="Completed" value={agent.stats.tasksCompleted} />
              <Stat label="Failed" value={agent.stats.tasksFailed} />
              <Stat label="Delegated" value={agent.stats.delegationsMade} />
              <Stat label="Tool calls" value={agent.stats.toolCalls} />
              <Stat label="👍" value={agent.stats.feedbackPositive} />
              <Stat label="👎" value={agent.stats.feedbackNegative} />
            </div>

            <div className="section-label">Current task</div>
            {currentTask ? (
              <div className="pad" style={{ paddingTop: 0 }}>
                <div className="card">
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span
                      className="status-dot active"
                      style={{ ['--status-color' as string]: TASK_STATUS_COLOR[currentTask.status] }}
                    />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{currentTask.title}</span>
                  </div>
                  {currentTask.description ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {currentTask.description.slice(0, 400)}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <Empty>Not working on anything right now.</Empty>
            )}

            <div className="section-label">Live step trace</div>
            {detail.loading ? (
              <div className="pad">
                <Spinner />
              </div>
            ) : (
              <RunTimeline run={detail.data?.runs[0] ?? null} agentId={agentId} />
            )}
          </>
        ) : null}

        {tab === 'activity' ? (
          <RunHistory detail={detail.data} loading={detail.loading} now={now} />
        ) : null}

        {tab === 'memory' ? (
          <>
            <div className="section-label">What this agent knows</div>
            {(detail.data?.memories ?? []).length === 0 ? (
              <Empty icon="⌾">Nothing stored for this agent yet.</Empty>
            ) : (
              (detail.data?.memories ?? []).map((record) => (
                <div className="memory-item" key={record.id}>
                  <div className="memory-head">
                    {record.pinned ? <span>📌</span> : null}
                    <span className="memory-title">{record.title}</span>
                    <Badge tone={record.kind === 'feedback' ? 'warn' : 'neutral'}>{record.kind}</Badge>
                  </div>
                  <div className="memory-content clamped">{record.content}</div>
                  <div className="dim" style={{ fontSize: 10.5, marginTop: 5 }}>
                    {record.scope} · used {record.useCount}× · {relativeTime(record.updatedAt, now)}
                  </div>
                </div>
              ))
            )}
          </>
        ) : null}

        {tab === 'tools' ? (
          <>
            <div className="section-label">Tools this agent may call</div>
            {(detail.data?.capabilities ?? []).map((tool) => (
              <div className="memory-item" key={tool.name}>
                <div className="memory-head">
                  <span className="memory-title mono">{tool.name}</span>
                  <Badge
                    tone={tool.risk === 'dangerous' ? 'danger' : tool.risk === 'guarded' ? 'warn' : 'ok'}
                  >
                    {TOOL_RISK_LABEL[tool.risk]}
                  </Badge>
                </div>
                <div className="memory-content clamped">{tool.description}</div>
              </div>
            ))}
            <div className="pad dim" style={{ fontSize: 11.5 }}>
              Anything not listed here is refused at execution time, even if the model asks for it.
            </div>
          </>
        ) : null}

        {tab === 'config' ? <AgentConfig agentId={agentId} onSaved={() => detail.reload()} /> : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/**
 * Live step trace for the current run.
 *
 * Steps come from the run's persisted step log, which is what the agent
 * actually did — every tool call, its arguments summary, and whether it
 * succeeded. It is an activity record, not a reconstruction of the model's
 * internal reasoning.
 */
function RunTimeline({ run, agentId }: { run: AgentRun | null; agentId: string }) {
  const steps = useAsync<RunStep[]>(
    async (signal) => {
      if (!run) return [];
      void signal;
      const response = await api.agentRun(agentId, run.id);
      return response.run.steps;
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
    <div className="pad">
      <div className="timeline">
        {list.map((step) => (
          <div
            key={step.id}
            className={`timeline-item ${step.ok ? 'ok' : 'err'}`}
            title={step.toolName ?? step.kind}
          >
            <div className="row" style={{ gap: 6 }}>
              {step.toolName ? <span className="mono dim">{step.toolName}</span> : null}
              {step.durationMs > 0 ? (
                <span className="dim" style={{ fontSize: 10.5 }}>
                  {duration(step.durationMs)}
                </span>
              ) : null}
            </div>
            <div className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {step.summary.slice(0, 600)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunHistory({
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
  if (runs.length === 0) return <Empty icon="🕘">No history yet.</Empty>;

  return (
    <>
      <div className="section-label">Recent runs</div>
      {runs.map((run) => (
        <div className="memory-item" key={run.id}>
          <div className="memory-head">
            <span className="memory-title">{run.result?.slice(0, 80) ?? run.error ?? 'Run'}</span>
            <Badge
              tone={
                run.status === 'succeeded'
                  ? 'ok'
                  : run.status === 'failed'
                    ? 'danger'
                    : run.status === 'cancelled'
                      ? 'neutral'
                      : 'accent'
              }
            >
              {run.status}
            </Badge>
          </div>
          <div className="dim" style={{ fontSize: 10.5 }}>
            {relativeTime(run.startedAt, now)} ·{' '}
            {run.endedAt ? duration(run.endedAt - run.startedAt) : 'running'} · {run.usage.toolCalls}{' '}
            tool calls · {run.usage.modelCalls} model calls
            {run.usage.provider ? ` · ${run.usage.provider}` : ''}
          </div>
        </div>
      ))}

      <div className="section-label">Recent tool calls</div>
      {(detail?.recentTools ?? []).slice(0, 25).map((entry) => (
        <div className="comms-row" key={entry.id}>
          <span className="mono" style={{ flex: 1 }}>
            {entry.toolName}
          </span>
          <Badge tone={entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'danger' : 'warn'}>
            {entry.outcome}
          </Badge>
          <span className="activity-time">{relativeTime(entry.createdAt, now)}</span>
        </div>
      ))}
    </>
  );
}

/** Live editing of an agent's identity, instructions and tool grants. */
function AgentConfig({ agentId, onSaved }: { agentId: string; onSaved: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const agent = useAgent(agentId);

  const [instructions, setInstructions] = useState(agent?.systemInstructions ?? '');
  const [temperature, setTemperature] = useState(agent?.temperature ?? 0.3);
  const [capabilities, setCapabilities] = useState<string[]>(agent?.capabilities ?? []);
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
    await api.updateAgent(agentId, { systemInstructions: instructions, temperature, capabilities });
    setDirty(false);
    onSaved();
  });

  const toggle = useCallback((name: string) => {
    setDirty(true);
    setCapabilities((current) =>
      current.includes(name) ? current.filter((c) => c !== name) : [...current, name],
    );
  }, []);

  if (!agent) return null;
  const canEdit = workspace.viewer.role !== 'viewer';

  return (
    <div className="pad">
      <div className="field">
        <label htmlFor="agent-instructions">System instructions</label>
        <textarea
          id="agent-instructions"
          className="textarea"
          style={{ minHeight: 220, fontFamily: 'var(--mono)', fontSize: 11.5 }}
          value={instructions}
          disabled={!canEdit}
          onChange={(e) => {
            setInstructions(e.target.value);
            setDirty(true);
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="agent-temp">Temperature — {temperature.toFixed(2)}</label>
        <input
          id="agent-temp"
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
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          Unchecking a tool takes effect on this agent's next run.
        </div>
        {byCategory.map(([category, tools]) => (
          <div key={category} style={{ marginBottom: 10 }}>
            <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 3 }}>
              {category}
            </div>
            {tools.map((tool) => (
              <label
                key={tool.name}
                className="row"
                style={{ fontSize: 12, padding: '2px 0', cursor: canEdit ? 'pointer' : 'default' }}
              >
                <input
                  type="checkbox"
                  checked={capabilities.includes(tool.name)}
                  disabled={!canEdit}
                  onChange={() => toggle(tool.name)}
                />
                <span className="mono">{tool.name}</span>
                {tool.risk === 'dangerous' ? <Badge tone="danger">approval</Badge> : null}
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Model: <span className="mono">{agent.model}</span>
      </div>

      {canEdit ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => void save.run()}
          disabled={!dirty || save.pending}
        >
          {save.pending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      ) : null}
      <ErrorText>{save.error}</ErrorText>
    </div>
  );
}
