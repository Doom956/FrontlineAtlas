import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

// Settings > About shows the version and the day of the build.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };

// `npm run build` makes dist/index.html, one self-contained file you can open or host anywhere.
// VITE_ART_LAB=1 builds the art lab into the same page (shown at #artlab, src/client/artlab/); without it the lab is
// dropped from the bundle. VITE_ART_STYLE and VITE_ART_MOTION pick the art (src/client/art/artStyle.ts).
export default defineConfig({
  base: './',
  define: {
    __ART_LAB__: JSON.stringify(process.env.VITE_ART_LAB === '1'),
    __APP_VERSION__: JSON.stringify(pkg.version ?? ''),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [viteSingleFile()],
  test: { globals: true, environment: 'node' },
});
