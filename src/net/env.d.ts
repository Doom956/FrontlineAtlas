// Build-time variables Vite puts on import.meta.env (only the ones the client reads).
interface ImportMetaEnv {
  /** multiplayer server, e.g. wss://frontline-atlas.example.com (docs/MULTIPLAYER.md section 4) */
  readonly VITE_SERVER_URL?: string;
  /** optional build id sent in `hello` (else a fingerprint of the balance data, see net/client.ts) */
  readonly VITE_BUILD_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
