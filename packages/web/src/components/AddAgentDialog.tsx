import { useMemo, useState } from 'react';
import type { AgentTemplate } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useAsync, useWorkspaceOrThrow } from '../state/hooks.js';
import { ErrorNote, Spinner, Tag } from './primitives.js';

/**
 * Adding an agent.
 *
 * Templates are a starting point, not a menu of allowed options — the "from
 * scratch" path takes any role string and any set of tool grants, which is what
 * makes the roster genuinely extensible rather than a fixed cast.
 */
export function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const templates = useAsync(async () => (await api.agentTemplates()).templates, []);

  const [selected, setSelected] = useState<AgentTemplate | null>(null);
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [tagline, setTagline] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [instructions, setInstructions] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);

  const existingRoles = useMemo(
    () => new Set(workspace.agents.map((a) => a.role.toLowerCase())),
    [workspace.agents],
  );

  const byCategory = useMemo(() => {
    const groups = new Map<string, typeof workspace.tools>();
    for (const tool of workspace.tools) {
      if (tool.orchestratorOnly) continue;
      const list = groups.get(tool.category) ?? [];
      list.push(tool);
      groups.set(tool.category, list);
    }
    return [...groups.entries()];
  }, [workspace.tools]);

  const create = useAction(async () => {
    if (custom) {
      await api.createAgent(workspace.workspace.id, {
        name: name.trim(),
        role: role.trim(),
        tagline,
        avatarEmoji: emoji,
        systemInstructions: instructions,
        capabilities,
      });
    } else if (selected) {
      await api.createAgent(workspace.workspace.id, {
        template: selected.key,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
    }
    onClose();
  });

  const pick = (template: AgentTemplate) => {
    setSelected(template);
    setCustom(false);
    setName('');
  };

  const startCustom = () => {
    setCustom(true);
    setSelected(null);
    setCapabilities(['send_message', 'return_result', 'memory_search', 'memory_write', 'update_task']);
    setInstructions(
      'You are one participant in a shared multiplayer workspace.\n\n' +
        'Describe what this agent is for, how it should work, and what it must never do.\n' +
        'Finish by calling return_result exactly once with your deliverable.',
    );
  };

  const canCreate = custom
    ? name.trim().length > 0 && role.trim().length > 0 && instructions.trim().length > 0
    : selected !== null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(3, 4, 7, 0.62)', backdropFilter: 'blur(6px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Add an agent"
    >
      <div
        className="gate__card"
        style={{ maxWidth: 620, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div className="row" style={{ marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <h2 className="gate__title" style={{ fontSize: 18 }}>
              Add an agent
            </h2>
            <p className="gate__sub" style={{ margin: 0 }}>
              New roles need no code change — pick a blueprint or define your own.
            </p>
          </div>
          <button type="button" className="btn btn--quiet btn--sm" onClick={onClose}>
            Close
          </button>
        </div>

        {templates.loading ? (
          <Spinner />
        ) : (
          <div className="col-gap" style={{ marginBottom: 14 }}>
            {(templates.data ?? []).map((template) => {
              const duplicate = existingRoles.has(template.role.toLowerCase());
              return (
                <button
                  key={template.key}
                  type="button"
                  className="card card--tap"
                  style={{
                    textAlign: 'left',
                    borderColor: selected?.key === template.key ? 'var(--iris)' : undefined,
                  }}
                  onClick={() => pick(template)}
                >
                  <div className="row">
                    <span style={{ fontSize: 18 }}>{template.avatarEmoji}</span>
                    <span style={{ fontWeight: 650 }}>{template.name}</span>
                    <Tag>{template.role}</Tag>
                    {duplicate ? <Tag tone="amber">already on the team</Tag> : null}
                    {template.isOrchestrator ? <Tag tone="iris">lead</Tag> : null}
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
                    {template.tagline}
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              className="card card--tap"
              style={{ textAlign: 'left', borderColor: custom ? 'var(--iris)' : undefined }}
              onClick={startCustom}
            >
              <div className="row">
                <span style={{ fontSize: 18 }}>✨</span>
                <span style={{ fontWeight: 650 }}>Something else</span>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
                Define a role of your own with its own instructions and tools.
              </div>
            </button>
          </div>
        )}

        {selected && !custom ? (
          <div className="field">
            <label htmlFor="agent-name-override">Name (optional)</label>
            <input
              id="agent-name-override"
              className="input"
              value={name}
              placeholder={selected.name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : null}

        {custom ? (
          <>
            <div className="row" style={{ gap: 10 }}>
              <div className="field" style={{ flex: '0 0 68px' }}>
                <label htmlFor="agent-emoji">Icon</label>
                <input
                  id="agent-emoji"
                  className="input"
                  value={emoji}
                  maxLength={4}
                  style={{ textAlign: 'center', fontSize: 18 }}
                  onChange={(e) => setEmoji(e.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="agent-name">Name</label>
                <input
                  id="agent-name"
                  className="input"
                  value={name}
                  placeholder="e.g. Iris"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="agent-role">Role</label>
                <input
                  id="agent-role"
                  className="input"
                  value={role}
                  placeholder="e.g. Data Engineer"
                  onChange={(e) => setRole(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="agent-tagline">One-line remit</label>
              <input
                id="agent-tagline"
                className="input"
                value={tagline}
                placeholder="What this agent is for, in a sentence."
                onChange={(e) => setTagline(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="agent-instr">System instructions</label>
              <textarea
                id="agent-instr"
                className="textarea"
                style={{ minHeight: 160, fontFamily: 'var(--mono)', fontSize: 11.5 }}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <div className="field">
              <label>Tools it may call</label>
              {byCategory.map(([category, tools]) => (
                <div key={category} style={{ marginBottom: 8 }}>
                  <div
                    className="faint"
                    style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 2 }}
                  >
                    {category}
                  </div>
                  {tools.map((tool) => (
                    <label key={tool.name} className="row" style={{ fontSize: 12, padding: '2px 0' }}>
                      <input
                        type="checkbox"
                        checked={capabilities.includes(tool.name)}
                        onChange={() =>
                          setCapabilities((current) =>
                            current.includes(tool.name)
                              ? current.filter((c) => c !== tool.name)
                              : [...current, tool.name],
                          )
                        }
                      />
                      <span className="mono">{tool.name}</span>
                      {tool.risk === 'dangerous' ? <Tag tone="rose">approval</Tag> : null}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : null}

        <button
          type="button"
          className="btn btn--primary"
          style={{ width: '100%' }}
          onClick={() => void create.run()}
          disabled={!canCreate || create.pending}
        >
          {create.pending ? <Spinner /> : 'Add to the team'}
        </button>

        <ErrorNote>{create.error}</ErrorNote>
      </div>
    </div>
  );
}
