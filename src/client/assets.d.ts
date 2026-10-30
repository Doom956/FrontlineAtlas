// Vite asset imports used by the client (fonts are bundled locally; the single-file build inlines them).
declare module '*.woff2?url' {
  const src: string;
  export default src;
}
