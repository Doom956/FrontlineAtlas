import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` makes dist/index.html, one self-contained file you can open or host anywhere.
// VITE_ART_LAB=1 builds the art lab into the same page (shown at #artlab, src/client/artlab/); without it the lab is
// dropped from the bundle. VITE_ART_STYLE and VITE_ART_MOTION pick the art (src/client/art/artStyle.ts).
export default defineConfig({
  base: './',
  define: { __ART_LAB__: JSON.stringify(process.env.VITE_ART_LAB === '1') },
  plugins: [viteSingleFile()],
  test: { globals: true, environment: 'node' },
});
