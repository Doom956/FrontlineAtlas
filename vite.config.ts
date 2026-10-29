import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` makes dist/index.html, one self-contained file you can open or host anywhere.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  test: { globals: true, environment: 'node' },
});
