import { useState } from 'react';
import type { WorkspaceFile } from '@sup/shared';
import { api } from '../api/client.js';
import { useActorLookup, useAsync, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Markdown } from './Markdown.js';
import { Badge, Empty, PanelHeader, Spinner, relativeTime } from './primitives.js';

/** Artifacts the team has produced. File bodies load on demand. */
export function FilesPanel() {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(30_000);
  const [openFile, setOpenFile] = useState<WorkspaceFile | null>(null);

  if (openFile) {
    return <FileViewer file={openFile} onClose={() => setOpenFile(null)} />;
  }

  return (
    <>
      <PanelHeader title="Files" count={workspace.files.length} />
      <div className="column-scroll">
        {workspace.files.length === 0 ? (
          <Empty icon="▣">
            No artifacts yet. Agents write reports and documents here as they finish work.
          </Empty>
        ) : (
          workspace.files
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((file) => {
              const author = lookup(file.createdBy.id);
              return (
                <button
                  key={file.id}
                  type="button"
                  className="memory-item"
                  style={{ display: 'block', width: '100%', textAlign: 'left' }}
                  onClick={() => setOpenFile(file)}
                >
                  <div className="memory-head">
                    <span className="memory-title mono">{file.path}</span>
                    {file.version > 1 ? <Badge>v{file.version}</Badge> : null}
                  </div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {formatBytes(file.size)} · {author.name} · {relativeTime(file.updatedAt, now)}
                  </div>
                </button>
              );
            })
        )}
      </div>
    </>
  );
}

function FileViewer({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  // The snapshot omits file bodies (they can be large), so fetch on open.
  const content = useAsync(async () => (await api.readFile(file.id)).file, [file.id, file.version]);

  return (
    <>
      <PanelHeader title={file.path}>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Back
        </button>
      </PanelHeader>
      <div className="column-scroll">
        <div className="pad">
          {content.loading ? (
            <Spinner />
          ) : content.error ? (
            <div style={{ color: 'var(--danger)' }}>{content.error}</div>
          ) : file.mimeType === 'text/markdown' ? (
            <Markdown text={content.data?.content ?? ''} />
          ) : (
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {content.data?.content}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
