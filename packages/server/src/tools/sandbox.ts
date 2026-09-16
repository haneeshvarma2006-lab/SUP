import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '../util/logger.js';

export interface ExecutionRequest {
  language: string;
  source: string;
  stdin?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT_BYTES = 200_000;

/**
 * Runs agent-authored code in a child process.
 *
 * What this actually provides: a scratch working directory that is deleted
 * afterwards, a hard wall-clock timeout with SIGKILL escalation, output caps, a
 * stripped environment, and no shell (argv is passed directly, so the source is
 * never interpreted by a shell).
 *
 * What it does NOT provide: kernel-level isolation. The child runs as the same
 * user as the server and can read the filesystem and open sockets. That is why
 * `code_exec` is classified `dangerous` and gated on human approval by default.
 * For untrusted multi-tenant use, replace this class with a container or
 * microVM backend — the ToolServices interface is the seam to do it at, and
 * nothing above this file changes.
 */
export class CodeSandbox {
  constructor(private readonly logger: Logger) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const runtime = RUNTIMES[request.language.toLowerCase()];
    if (!runtime) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: `Unsupported language "${request.language}". Supported: ${Object.keys(RUNTIMES).join(', ')}`,
        timedOut: false,
      };
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'sup-exec-'));
    const file = path.join(dir, runtime.filename);

    try {
      await writeFile(file, request.source, 'utf8');
      return await this.spawnChild(runtime.command, [...runtime.args, file], {
        cwd: dir,
        stdin: request.stdin ?? '',
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        this.logger.warn('failed to clean sandbox directory', { dir, error: err });
      });
    }
  }

  private spawnChild(
    command: string,
    args: string[],
    options: { cwd: string; stdin: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        // A minimal environment: the child gets no API keys, no database path,
        // nothing it could exfiltrate from the server's own configuration.
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: options.cwd,
          TMPDIR: options.cwd,
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
          NODE_OPTIONS: '',
        },
        // No shell: `source` is a file argument, never a command line.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        options.signal.removeEventListener('abort', onAbort);
        resolve({ exitCode, stdout, stderr, timedOut });
      };

      const capture = (chunk: Buffer, target: 'out' | 'err') => {
        const text = chunk.toString('utf8');
        if (target === 'out') {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text;
        }
        // Once both streams are capped there is nothing more to learn; stop the
        // child rather than letting it produce gigabytes we discard.
        if (stdout.length >= MAX_OUTPUT_BYTES && stderr.length >= MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
        }
      };

      child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
      child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

      let forceTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // SIGTERM can be ignored; escalate so a hung child cannot outlive us.
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      }, options.timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(-1);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        finish(-1);
      });
      child.on('close', (code) => finish(code ?? -1));

      if (options.stdin) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}

const RUNTIMES: Record<string, { command: string; args: string[]; filename: string }> = {
  python: { command: 'python3', args: ['-I', '-B'], filename: 'main.py' },
  python3: { command: 'python3', args: ['-I', '-B'], filename: 'main.py' },
  javascript: { command: process.execPath, args: [], filename: 'main.mjs' },
  js: { command: process.execPath, args: [], filename: 'main.mjs' },
  node: { command: process.execPath, args: [], filename: 'main.mjs' },
};
