// Trim, loudness-normalise (BS.1770 integrated LUFS) and encode to Ogg Opus in headless Chromium (WebCodecs).
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
const require = createRequire('D:/FrontlineAtlas-docs/node_modules/');
const { chromium } = require('playwright');
const S = process.argv[2], OUT = process.argv[3], ONLY = process.argv[4];
mkdirSync(OUT, { recursive: true });
const spec = JSON.parse(readFileSync(S + '/tools/spec.json', 'utf8')).filter(o => !ONLY || (ONLY === 'R2' ? o.round === 2 : o.id.includes(ONLY)));
const srcFiles = readdirSync(S + '/dl/src');
const b = await chromium.launch();
const p = await b.newPage();
p.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await p.route('https://snd.test/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname === '/') return r.fulfill({ body: '<html></html>', contentType: 'text/html' });
  return r.fulfill({ body: readFileSync(decodeURIComponent(u.pathname.slice(1))), contentType: 'application/octet-stream' });
});
await p.goto('https://snd.test/');
await p.evaluate(() => {
  // K-weighting at 48 kHz (BS.1770-4 coefficients)
  const biq = (x, b0, b1, b2, a1, a2) => { const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  const kw = x => biq(biq(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
    1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621);
  window.lufs = (chs) => {
    const k = chs.map(kw), n = k[0].length, blk = 19200, hop = 4800, ms = [];
    if (n < blk) { let s = 0; for (const c of k) for (let i = 0; i < n; i++) s += c[i] * c[i]; return -0.691 + 10 * Math.log10(s / n + 1e-12); }
    for (let st = 0; st + blk <= n; st += hop) { let s = 0; for (const c of k) for (let i = st; i < st + blk; i++) s += c[i] * c[i]; ms.push(s / blk); }
    const L = m => -0.691 + 10 * Math.log10(m + 1e-12);
    let g = ms.filter(m => L(m) > -70); if (!g.length) return -70;
    const rel = L(g.reduce((a, b) => a + b, 0) / g.length) - 10; g = g.filter(m => L(m) > rel);
    return L(g.reduce((a, b) => a + b, 0) / g.length);
  };
  window.onsets = (chs) => {
    const n = chs[0].length, F = 480, nf = Math.floor(n / F), e = new Float32Array(nf);
    for (let f = 0; f < nf; f++) { let s = 0; for (const c of chs) for (let i = f * F; i < (f + 1) * F; i++) s += c[i] * c[i]; e[f] = Math.sqrt(s / F / chs.length); }
    let P = 0; for (const v of e) P = Math.max(P, v);
    const out = []; let last = -1e9;
    for (let f = 1; f < nf; f++) {
      let mn = Infinity; for (let k = Math.max(0, f - 25); k < f; k++) mn = Math.min(mn, e[k]);
      if (e[f] > 0.15 * P && e[f] > 5 * mn + 1e-5 && e[f] > e[f - 1] && f - last > 40) { out.push(f * F / 48000); last = f; }
    }
    if (!out.length) { let a = 0; for (let f = 0; f < nf; f++) if (e[f] > 0.15 * P) { a = f; break; } out.push(a * F / 48000); }
    return out;
  };
  window.proc = async (paths, o) => {
    const isMusic = o.category.startsWith('music') || o.category.startsWith('sting');
    const R = 48000, nc = isMusic ? 2 : 1;
    const layers = o.layers && o.layers.length ? o.layers : [{ start: o.start, offset: 0, gainDb: 0 }];
    const parts = []; let srcDur = 0; const info = [];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const ab = await (await fetch('/' + encodeURIComponent(paths[li]))).arrayBuffer();
      const buf = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(ab);
      if (li === 0) srcDur = buf.duration;
      let ch = []; for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
      if (nc === 1) { const m = new Float32Array(ch[0].length); for (const c of ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / ch.length; ch = [m]; }
      else ch = ch.length === 1 ? [ch[0], ch[0]] : ch.slice(0, 2);
      let st = L.start || 0, ons = null;
      if (typeof st === 'string') { ons = onsets(ch); const k = parseInt(st.slice(1)) - 1; st = Math.max(0, (ons[Math.min(k, ons.length - 1)] || 0) - 0.03); }
      info.push({ start: +st.toFixed(3), onsets: ons ? ons.slice(0, 12).map(x => +x.toFixed(2)) : null, dur: +buf.duration.toFixed(2) });
      const a = Math.floor(st * R), z = Math.min(ch[0].length, a + Math.floor((o.max + 2) * R)), g = Math.pow(10, (L.gainDb || 0) / 20);
      parts.push({ off: Math.floor((L.offset || 0) * R), data: ch.map(c => { const x = c.slice(a, z); for (let i = 0; i < x.length; i++) x[i] *= g; return x; }) });
    }
    const total = Math.max(...parts.map(p => p.off + p.data[0].length));
    let chs = Array.from({ length: nc }, () => new Float32Array(total));
    for (const p of parts) for (let c = 0; c < nc; c++) { const d = chs[c], s2 = p.data[c]; for (let i = 0; i < s2.length; i++) d[p.off + i] += s2[i]; }
    o = Object.assign({}, o, { start: 0 });
    const n = chs[0].length; let peak = 0; for (const c of chs) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
    const thr = peak * Math.pow(10, -45 / 20);
    const loud = i => chs.some(c => Math.abs(c[i]) > thr);
    let a = Math.floor(o.start * R); while (a < n - 1 && !loud(a)) a++;
    let z = n - 1; while (z > a && !loud(z)) z--;
    a = Math.max(0, a - Math.floor(0.004 * R)); z = Math.min(n, z + Math.floor(0.02 * R));
    const loop = isMusic && o.category.startsWith('music') && srcDur < 60;
    let cut = false; if (!loop && (z - a) / R > o.max) { z = a + Math.floor(o.max * R); cut = true; }
    let out = chs.map(c => c.slice(a, z)); const len = z - a;
    const fin = loop ? 0 : Math.floor(Math.min(isMusic ? 0.02 : 0.005, 0.1 * len / R) * R);
    const fout = loop ? 0 : cut ? Math.floor(Math.min(isMusic ? (o.category.startsWith('music') ? 4 : 1.2) : 0.3 * len / R + 0.02, len / R * 0.4) * R) : Math.floor(Math.min(isMusic ? 0.01 : 0.03, 0.3 * len / R) * R);
    for (const c of out) { for (let i = 0; i < fin; i++) c[i] *= i / fin; for (let i = 0; i < fout; i++) c[len - 1 - i] *= Math.pow(i / fout, 1.5); }
    const before = lufs(out), target = isMusic ? -20 : -16;
    let gain = Math.pow(10, (target - before) / 20), pk = 0; for (const c of out) for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(c[i]));
    const ceil = Math.pow(10, -1 / 20); let limited = false; if (pk * gain > ceil) { gain = ceil / pk; limited = true; }
    for (const c of out) for (let i = 0; i < len; i++) c[i] *= gain;
    const after = lufs(out);
    // encode
    const pkts = []; let meta = null;
    const enc = new AudioEncoder({ output: (ch, md) => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); pkts.push([Array.from(d), ch.duration]); if (md && md.decoderConfig) meta = md.decoderConfig; }, error: e => console.error(e) });
        enc.configure({ codec: 'opus', sampleRate: R, numberOfChannels: nc, bitrate: isMusic ? 80000 : 64000, opus: { frameDuration: 20000, complexity: 10 } });
    const F = 4800;
    for (let s = 0; s < len; s += F) {
      const m = Math.min(F, len - s), d = new Float32Array(m * nc); for (let c = 0; c < nc; c++) d.set(out[c].subarray(s, s + m), c * m);
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: R, numberOfFrames: m, numberOfChannels: nc, timestamp: Math.round(s / R * 1e6), data: d }));
    }
    await enc.flush(); enc.close();
    const desc = meta && meta.description ? Array.from(new Uint8Array(meta.description.buffer ? meta.description.buffer : meta.description)) : null;
    return { info, srcDur, channels: nc, samples: len, dur: len / R, lufsIn: before, lufs: after, limited, cut, loop, pkts, desc };
  };
  window.check = async (bytes) => { const ctx = new OfflineAudioContext(2, 48000, 48000); const buf = await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
    const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c)); return { dur: buf.duration, lufs: lufs(chs) }; };
});
// ---- Ogg muxer
const CRC = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }
const crc = b => { let c = 0; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 255]) >>> 0; return c; };
function page(pkts, granule, seq, flags) {
  const lace = []; for (const q of pkts) { let l = q.length; while (l >= 255) { lace.push(255); l -= 255; } lace.push(l); }
  const h = Buffer.alloc(27 + lace.length); h.write('OggS', 0); h[4] = 0; h[5] = flags;
  h.writeBigInt64LE(BigInt(granule), 6); h.writeUInt32LE(0x46415441, 14); h.writeUInt32LE(seq, 18); h.writeUInt32LE(0, 22); h[26] = lace.length; Buffer.from(lace).copy(h, 27);
  const pg = Buffer.concat([h, ...pkts.map(q => Buffer.from(q))]); pg.writeUInt32LE(crc(pg), 22); return pg;
}
function ogg(r, o) {
  let head;
  if (r.desc && r.desc.length >= 19 && Buffer.from(r.desc.slice(0, 8)).toString() === 'OpusHead') head = Buffer.from(r.desc);
  else { head = Buffer.alloc(19); head.write('OpusHead', 0); head[8] = 1; head[9] = r.channels; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12); head.writeInt16LE(0, 16); head[18] = 0; }
  const pre = head.readUInt16LE(10);
  const cm = [`TITLE=${o.title}`, `ARTIST=${o.author}`, `LICENSE=${o.licence} ${o.licenceUrl}`, `CONTACT=${o.source}`].map(s => Buffer.from(s, 'utf8'));
  const vendor = Buffer.from('Frontline Atlas sound candidates');
  const tags = Buffer.concat([Buffer.from('OpusTags'), u32(vendor.length), vendor, u32(cm.length), ...cm.flatMap(c => [u32(c.length), c])]);
  const pages = [page([head], 0, 0, 2), page([tags], 0, 1, 0)];
  let seq = 2, gran = pre, batch = [], segs = 0;
  const total = pre + r.samples;
  r.pkts.forEach(([d, durUs], i) => {
    const ns = Math.round(durUs * 48000 / 1e6) || 960; const sg = Math.floor(d.length / 255) + 1;
    if (segs + sg > 255 || batch.length >= 50) { pages.push(page(batch, Math.min(gran, total), seq++, 0)); batch = []; segs = 0; }
    batch.push(d); segs += sg; gran += ns;
  });
  pages.push(page(batch, total, seq++, 4));
  return Buffer.concat(pages);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const results = [];
for (const o of spec) {
  const layFiles = readdirSync(S + '/dl/lay');
  const paths = o.layers && o.layers.length ? o.layers.map(l => `${S}/dl/lay/` + layFiles.find(x => x.startsWith(l.key + '.'))) : [`${S}/dl/src/` + srcFiles.find(x => x.startsWith(o.id + '.'))];
  try {
    if (paths.some(x => x.endsWith('undefined'))) throw new Error('missing source file ' + paths.join(','));
    const r = await p.evaluate(([paths, o]) => proc(paths, o), [paths, o]);
    const bytes = ogg(r, o); const file = `${o.id}.ogg`; writeFileSync(`${OUT}/${file}`, bytes);
    const chk = await p.evaluate(b => check(b), Array.from(bytes));
    const row = { id: o.id, file, srcDur: +r.srcDur.toFixed(2), dur: +r.dur.toFixed(2), decodedDur: +chk.dur.toFixed(2), channels: r.channels, lufsIn: +r.lufsIn.toFixed(1), lufs: +chk.lufs.toFixed(1), limited: r.limited, cut: r.cut, loop: r.loop, bytes: bytes.length, head: !!r.desc, info: r.info };
    results.push(row); console.log(JSON.stringify(row));
  } catch (e) { console.log('FAIL', o.id, String(e).slice(0, 300)); }
}
writeFileSync(`${S}/tools/results${ONLY ? '-' + ONLY : ''}.json`, JSON.stringify(results, null, 1));
await b.close();
