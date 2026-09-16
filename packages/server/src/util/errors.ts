/** Errors that map onto an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Safe to show the end user verbatim. */
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details ?? null;
    this.expose = options.expose ?? status < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, { details });

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to do that', details?: unknown) =>
  new AppError(403, 'forbidden', message, { details });

export const notFound = (what: string) =>
  new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, { details });

export const tooManyRequests = (message: string) =>
  new AppError(429, 'rate_limited', message);

export const internal = (message: string, cause?: unknown) =>
  new AppError(500, 'internal_error', message, { cause, expose: false });

/** Thrown when a run is cancelled; distinguishable from a genuine failure. */
export class CancellationError extends Error {
  constructor(reason = 'cancelled') {
    super(reason);
    this.name = 'CancellationError';
  }
}

export function isCancellation(err: unknown): err is CancellationError {
  return err instanceof CancellationError || (err instanceof Error && err.name === 'AbortError');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
