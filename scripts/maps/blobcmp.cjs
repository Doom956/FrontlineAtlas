// node scripts/maps/blobcmp.cjs <fileA> <fileB>: compares the decompressed map blobs of two src/maps/data files
const fs = require('fs'), zlib = require('zlib');
const raw = (f) => { const s = fs.readFileSync(f, 'utf8'); const m = s.match(/['"`]([A-Za-z0-9+/=]{200,})['"`]/); return zlib.gunzipSync(Buffer.from(m[1], 'base64')); };
const a = raw(process.argv[2]), b = raw(process.argv[3]);
let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
console.log(process.argv[3], a.equals(b) ? 'SAME' : `DIFF bytes ${d} len ${a.length}/${b.length}`);
