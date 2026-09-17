/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the SUP backend, e.g. https://sup-api.up.railway.app.
   * Unset means same-origin, which is how the single-process deployment runs.
   */
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
