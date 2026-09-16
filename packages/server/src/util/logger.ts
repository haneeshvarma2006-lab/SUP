type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(level: Level, bindings: Record<string, unknown> = {}): Logger {
  const threshold = ORDER[level];

  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...bindings,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) record[k] = serialiseError(v);
    }
    const line = JSON.stringify(record);
    if (lvl === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
