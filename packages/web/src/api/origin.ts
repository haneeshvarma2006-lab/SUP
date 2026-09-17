/**
 * Where the API and the realtime hub live.
 *
 * Empty by default, which means same-origin — in the normal deployment one Node
 * process serves this bundle, the REST API and the websocket on a single port,
 * so relative paths are already correct and nothing needs configuring.
 *
 * Set `VITE_API_ORIGIN` at build time to point a statically hosted frontend
 * (Vercel, Netlify, any CDN) at a backend running elsewhere. Auth travels as a
 * bearer token rather than a cookie, so a split origin needs no SameSite
 * gymnastics — just the origin on the server's `CORS_ORIGINS` list.
 */
const configured = (import.meta.env.VITE_API_ORIGIN ?? '').trim().replace(/\/+$/, '');

/** '' when same-origin, otherwise an absolute origin with no trailing slash. */
export const API_ORIGIN = configured;

export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

export function wsUrl(path = '/ws'): string {
  // http -> ws and https -> wss, so one setting covers both transports and the
  // two can never disagree about TLS.
  if (API_ORIGIN) return `${API_ORIGIN.replace(/^http/, 'ws')}${path}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
