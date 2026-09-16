import { useMemo, type ReactNode } from 'react';

/**
 * A small markdown renderer.
 *
 * Deliberately hand-rolled rather than pulled from a library, for one reason:
 * everything it renders is untrusted. Message bodies come from language models
 * and from other workspace members, so nothing here ever produces raw HTML —
 * the output is React elements built from parsed text, which means an `<img
 * onerror=...>` in a model's output is displayed as characters, not executed.
 *
 * Supports: headings, bold, italic, inline code, fenced code, links, ordered
 * and unordered lists, tables, blockquotes and rules. Anything else falls
 * through as plain text, which is the right failure mode.
 */
export function Markdown({ text, mentions }: { text: string; mentions?: string[] }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="message-text">{blocks.map((block, i) => renderBlock(block, i, mentions))}</div>;
}

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code. An unterminated fence runs to the end rather than swallowing
    // the rest of the document into a paragraph.
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        code.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ kind: 'code', language: fence[1] ?? '', lines: code });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    // Table: a header row followed by a separator row of dashes.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const match = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(current) : /^\s*[-*+]\s+(.*)$/.exec(current);
        if (!match) break;
        items.push(match[1]!);
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !isBlockStart(lines[i]!)) {
      paragraph.push(lines[i]!);
      i++;
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    else i++;
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('```') ||
    /^#{1,6}\s/.test(trimmed) ||
    /^[-*+]\s/.test(trimmed) ||
    /^\d+[.)]\s/.test(trimmed) ||
    trimmed.startsWith('>') ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
  );
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderBlock(block: Block, key: number, mentions?: string[]): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(3, block.level)}` as 'h1' | 'h2' | 'h3');
      return <Tag key={key}>{inline(block.text, mentions)}</Tag>;
    }
    case 'code':
      return (
        <pre key={key}>
          <code>{block.lines.join('\n')}</code>
        </pre>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{inline(item, mentions)}</li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return <blockquote key={key}>{inline(block.lines.join(' '), mentions)}</blockquote>;
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.header.map((cell, i) => (
                <th key={i}>{inline(cell, mentions)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{inline(cell, mentions)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'rule':
      return <hr key={key} />;
    case 'paragraph':
      return <p key={key}>{inline(block.lines.join('\n'), mentions)}</p>;
  }
}

/** Inline formatting. Order matters: code first, so `**` inside code is literal. */
function inline(text: string, mentions?: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>)]+)|(@[A-Za-z][A-Za-z0-9 _-]{0,30})/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    const [full] = match;

    if (full.startsWith('`')) {
      nodes.push(<code key={key++}>{full.slice(1, -1)}</code>);
    } else if (full.startsWith('**')) {
      nodes.push(<strong key={key++}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('*')) {
      nodes.push(<em key={key++}>{full.slice(1, -1)}</em>);
    } else if (full.startsWith('[')) {
      const label = /\[([^\]]+)\]/.exec(full)?.[1] ?? full;
      const href = match[5] ?? '#';
      nodes.push(
        // noreferrer as well as noopener: the target must not learn where the
        // click came from, and must not get a handle on this window.
        <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else if (full.startsWith('http')) {
      nodes.push(
        <a key={key++} href={full} target="_blank" rel="noopener noreferrer">
          {full}
        </a>,
      );
    } else if (full.startsWith('@')) {
      const name = full.slice(1).trimEnd();
      const known = !mentions || mentions.some((m) => m.toLowerCase() === name.toLowerCase());
      nodes.push(
        known ? (
          <span className="mention" key={key++}>
            @{name}
          </span>
        ) : (
          full
        ),
      );
      // A trailing space consumed by the mention pattern must be preserved.
      if (full.length > name.length + 1) nodes.push(full.slice(name.length + 1));
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
