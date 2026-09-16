import { useState } from 'react';
import type { WorkspaceFile } from '@sup/shared';
import { api } from '../api/client.js';
import { useActorLookup, useAsync, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Markdown } from './Markdown.js';
import { Avatar, Button, Empty, Icon, Spinner, Tag, bytesText, relTime } from './primitives.js';

/**
 * Artifacts the team has produced.
 *
 * Bodies are deliberately not in the workspace snapshot — a report can be tens
 * of kilobytes and every connected client would pay for it on every join — so
 * a file's content is fetched when it is opened.
 */
export function FilesPanel() {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(30_000);
  const [open, setOpen] = useState<WorkspaceFile | null>(null);

  if (open) return <Viewer file={open} onBack={() => setOpen(null)} />;

  if (workspace.files.length === 0) {
    return (
      <div className="scroll">
        <Empty icon={<Icon.File size={17} />} title="No artifacts yet">
          Reports and documents the team writes will collect here.
        </Empty>
      </div>
    );
  }

  return (
    <div className="scroll">
      {[...workspace.files]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((file) => {
          const who = lookup(file.createdBy.id);
          return (
            <button
              key={file.id}
              type="button"
              className="mem"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => setOpen(file)}
            >
              <div className="mem__head">
                <Icon.File size={12} className="faint" />
                <span className="mem__title mono">{file.path}</span>
                {file.version > 1 ? <Tag>v{file.version}</Tag> : null}
              </div>
              <div className="mem__foot" style={{ marginTop: 3 }}>
                <Avatar
                  name={who.name}
                  tint={who.color}
                  emoji={who.emoji}
                  kind={who.kind}
                  size="xs"
                />
                <span>{who.name}</span>
                <span className="grow" style={{ textAlign: 'right' }}>
                  {bytesText(file.size)} · {relTime(file.updatedAt, now)}
                </span>
              </div>
            </button>
          );
        })}
    </div>
  );
}

function Viewer({ file, onBack }: { file: WorkspaceFile; onBack: () => void }) {
  const content = useAsync(async () => (await api.readFile(file.id)).file, [file.id, file.version]);

  return (
    <>
      <div className="row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--hairline)' }}>
        <Button variant="quiet" size="sm" onClick={onBack} ariaLabel="Back to files">
          <Icon.Back size={12} />
        </Button>
        <span className="mono grow trunc">{file.path}</span>
        <span className="faint" style={{ fontSize: 11 }}>
          v{file.version}
        </span>
      </div>

      <div className="scroll">
        <div className="pad">
          {content.loading ? (
            <Spinner />
          ) : content.error ? (
            <div className="err">{content.error}</div>
          ) : file.mimeType === 'text/markdown' ? (
            <Markdown text={content.data?.content ?? ''} />
          ) : (
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
              {content.data?.content}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}
