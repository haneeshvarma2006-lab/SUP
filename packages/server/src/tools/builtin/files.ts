import { TOOL_NAMES, truncate } from '@sup/shared';
import { fail, ok, readString, schema, type Tool, type ToolResult } from '../types.js';

/**
 * Workspace file tools.
 *
 * "Files" here are rows in the workspace, not paths on the host filesystem.
 * Agents cannot reach the server's disk at all — path traversal is impossible
 * because there is no real path to traverse to.
 */

/** Rejects absolute paths, traversal segments and absurd names. */
export function normaliseWorkspacePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, '');
  if (!trimmed || trimmed.length > 200) return null;
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 8) return null;
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null;
    if (!/^[A-Za-z0-9._ -]+$/.test(segment)) return null;
  }
  return segments.join('/');
}

export const fileWriteTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.fileWrite,
    category: 'files',
    title: 'Write file',
    description:
      'Create or overwrite a file in the shared workspace. Writing an existing path creates a new version; nothing is lost silently.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        path: {
          type: 'string',
          description: 'Workspace-relative path, e.g. "reports/competitors.md".',
        },
        content: { type: 'string', description: 'Full file content.' },
        mime_type: { type: 'string', description: 'Defaults to text/markdown.' },
      },
      ['path', 'content'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const path = normaliseWorkspacePath(readString(input, 'path'));
    if (!path) {
      return fail(
        'Invalid file path',
        'Use a relative path with letters, numbers, dots, dashes and slashes only.',
      );
    }

    const content = readString(input, 'content');
    const limit = ctx.config.limits.maxFileBytes;
    if (Buffer.byteLength(content, 'utf8') > limit) {
      return fail(`File exceeds the ${Math.round(limit / 1024)}KB limit`);
    }

    const file = ctx.services.writeFile({
      ctx,
      path,
      content,
      mimeType: readString(input, 'mime_type') || inferMime(path),
    });

    return ok(`Wrote ${path} (v${file.version})`, {
      file_id: file.fileId,
      path: file.path,
      version: file.version,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  },
};

export const fileReadTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.fileRead,
    category: 'files',
    title: 'Read file',
    description: 'Read a file from the shared workspace.',
    risk: 'safe',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema({ path: { type: 'string', description: 'Workspace-relative path.' } }, ['path']),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const path = normaliseWorkspacePath(readString(input, 'path'));
    if (!path) return fail('Invalid file path');

    const file = ctx.repos.files.byPath(ctx.workspace.id, path);
    if (!file) {
      const available = ctx.repos.files.listForWorkspace(ctx.workspace.id).map((f) => f.path);
      return fail(
        `No file at ${path}`,
        available.length > 0 ? `Files in this workspace: ${available.join(', ')}` : 'The workspace has no files yet.',
      );
    }

    return ok(`Read ${path} (${file.size} bytes)`, {
      path: file.path,
      version: file.version,
      content: file.content,
    });
  },
};

export const fileListTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.fileList,
    category: 'files',
    title: 'List files',
    description: 'List the files that exist in the shared workspace.',
    risk: 'safe',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema({}, []),
  },
  async execute(_input, ctx): Promise<ToolResult> {
    const files = ctx.repos.files.listForWorkspace(ctx.workspace.id);
    return ok(`${files.length} file(s)`, {
      files: files.map((f) => ({
        path: f.path,
        bytes: f.size,
        version: f.version,
        author: f.createdBy.name ?? f.createdBy.id,
      })),
    });
  },
};

export const generateDocumentTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.generateDocument,
    category: 'files',
    title: 'Generate document',
    description:
      'Assemble a structured markdown document from sections and save it to the workspace. ' +
      'Use this for final deliverables so they get a consistent shape.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        path: { type: 'string', description: 'Where to save it, e.g. "reports/analysis.md".' },
        title: { type: 'string', description: 'Document title.' },
        summary: { type: 'string', description: 'Executive summary paragraph.' },
        sections: {
          type: 'array',
          description: 'Ordered body sections.',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['heading', 'body'],
          },
        },
      },
      ['path', 'title'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const path = normaliseWorkspacePath(readString(input, 'path'));
    if (!path) return fail('Invalid file path');

    const title = readString(input, 'title').trim() || 'Untitled';
    const summary = readString(input, 'summary').trim();
    const rawSections = Array.isArray(input.sections) ? input.sections : [];

    const sections = rawSections
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .map((s) => ({
        heading: typeof s.heading === 'string' ? s.heading : '',
        body: typeof s.body === 'string' ? s.body : '',
      }))
      .filter((s) => s.heading || s.body);

    if (!summary && sections.length === 0) {
      return fail('generate_document needs a summary or at least one section');
    }

    const document = [
      `# ${title}`,
      '',
      summary ? `## Summary\n\n${summary}` : '',
      ...sections.map((s) => `\n## ${s.heading}\n\n${s.body}`),
      '',
      `---\n\n_Produced by ${ctx.agent.name} (${ctx.agent.role}) in workspace "${ctx.workspace.name}"._`,
    ]
      .filter((part) => part !== '')
      .join('\n');

    const limit = ctx.config.limits.maxFileBytes;
    if (Buffer.byteLength(document, 'utf8') > limit) {
      return fail(`Document exceeds the ${Math.round(limit / 1024)}KB limit`);
    }

    const file = ctx.services.writeFile({ ctx, path, content: document, mimeType: 'text/markdown' });

    return ok(`Generated ${path}`, {
      file_id: file.fileId,
      path: file.path,
      version: file.version,
      preview: truncate(document, 400),
    });
  },
};

function inferMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'md':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'html':
      return 'text/html';
    case 'js':
    case 'ts':
    case 'py':
      return 'text/plain';
    default:
      return 'text/plain';
  }
}

export const fileTools: Tool[] = [fileWriteTool, fileReadTool, fileListTool, generateDocumentTool];
