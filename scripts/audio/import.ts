// Copies the picked sounds and music (src/client/sound/library.ts) from a sound-candidates folder into public/audio/,
// makes the AAC copies for browsers without Ogg (Safari before 18.4), re-encodes music above 88 kbps to 80 kbps Opus,
// and writes the credits (src/client/sound/credits.gen.ts and CREDITS.md, one credit per recording a layered file
// mixes) and each file's loudness (src/client/sound/loudness.gen.ts) from the candidates' manifest.json.
//
//   git fetch origin sound-candidates
//   mkdir -p /tmp/cand && git archive origin/sound-candidates sound-candidates | tar x -C /tmp/cand
//   npx vite-node scripts/audio/import.ts /tmp/cand/sound-candidates
//
// Needs ffmpeg on the PATH. An effect is replaced when its source differs; a music track only when the new source
// is no bigger than the file already here. The AAC copy is remade whenever its Ogg changed. Unused files are removed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { musicFileIds, sfxFileIds } from '../../src/client/sound/library';

interface Layer {
  title: string;
  author: string;
  source: string;
  licence: string;
  licenceUrl: string;
}

interface ManifestFile {
  id: string;
  layers?: Layer[];
  loudnessLufs?: number;
  category: string;
  title: string;
  author: string;
  source: string;
  licence: string;
  licenceUrl: string;
  credit?: string | null;
  file: string;
  durationSec: number;
  sizeBytes: number;
  format: string;
  variantOf?: string;
}

const src = process.argv[2];
if (!src || !existsSync(join(src, 'manifest.json'))) {
  console.error('usage: vite-node scripts/audio/import.ts <sound-candidates dir with manifest.json>');
  process.exit(1);
}
const root = resolve(import.meta.dirname ?? '.', '../..');
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')) as { files: ManifestFile[] };
const byId = new Map(manifest.files.map((f) => [f.id, f]));
const out = join(root, 'public/audio');

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function kbps(f: ManifestFile): number {
  const m = /(\d+)\s*kbps/.exec(f.format);
  return m ? Number(m[1]) : 0;
}

const used: ManifestFile[] = [];
for (const [kind, ids] of [['sfx', sfxFileIds()], ['music', musicFileIds()]] as const) {
  const dir = join(out, kind);
  mkdirSync(dir, { recursive: true });
  const want = new Set(ids);
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.(ogg|m4a)$/, '');
    if (!want.has(id)) rmSync(join(dir, name));
  }
  for (const id of ids) {
    const f = byId.get(id);
    if (!f) throw new Error(`${id}: not in the manifest`);
    used.push(f);
    const input = join(src, f.file);
    const ogg = join(dir, `${id}.ogg`);
    const m4a = join(dir, `${id}.m4a`);
    const music = kind === 'music';
    let fresh = false;
    if (!existsSync(ogg)) fresh = true;
    else if (music) fresh = statSync(input).size <= statSync(ogg).size && !readFileSync(input).equals(readFileSync(ogg));
    else fresh = !readFileSync(input).equals(readFileSync(ogg));
    if (fresh) {
      if (music && kbps(f) > 88) {
        const tmp = join(tmpdir(), `fa-${id}.ogg`);
        ffmpeg(['-i', input, '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '80k', '-vbr', 'on', tmp]);
        copyFileSync(tmp, ogg);
        rmSync(tmp);
      } else copyFileSync(input, ogg);
    }
    if (fresh || !existsSync(m4a)) {
      const ch = /mono/.test(f.format) ? ['-ac', '1'] : ['-ac', '2'];
      ffmpeg(['-i', ogg, '-map_metadata', '-1', ...ch, '-ar', '48000', '-c:a', 'aac', '-b:a', music ? '96k' : '64k', '-movflags', '+faststart', m4a]);
    }
    console.log(`${kind}/${id}: ogg ${statSync(ogg).size} B, m4a ${statSync(m4a).size} B`);
  }
}

// ------------------------------------------------------------------------------------------------ credits

// one credit per recording: a layered file mixes several, each with its own licence
interface Credit extends Layer {
  line: string;
}
const credits: Credit[] = [];
for (const f of used) {
  const layers: Layer[] = f.layers && f.layers.length ? f.layers : [f];
  for (const l of layers) {
    const by = /^CC BY/.test(l.licence);
    const exact = layers.length === 1 && f.credit ? f.credit : null; // the manifest's own line, as given
    const line = by ? (exact ?? `"${l.title}" by ${l.author} (${l.source}), licensed under ${l.licence} (${l.licenceUrl}); trimmed, levelled and re-encoded`) : `"${l.title}" by ${l.author} (${l.source}), ${l.licence}`;
    credits.push({ ...l, line });
  }
}
const uniq = <T>(xs: T[], key: (x: T) => string): T[] => [...new Map(xs.map((x) => [key(x), x])).values()];
const cc = uniq(credits.filter((c) => /^CC BY/.test(c.licence)), (c) => c.source + c.title);
const cc0 = uniq(credits.filter((c) => !/^CC BY/.test(c.licence)), (c) => c.source + c.title);

const q = (s: string) => JSON.stringify(s);
const ts =
  '// Generated by scripts/audio/import.ts from the sound-candidates manifest: do not edit by hand.\n\n' +
  'export interface CreditLine {\n  title: string;\n  author: string;\n  licence: string;\n  source: string;\n}\n\n' +
  '/** CC BY files: the credit lines exactly as the manifest gives them. */\n' +
  `export const CC_BY_CREDITS: readonly string[] = [\n${cc.map((c) => `  ${q(c.line)},`).join('\n')}\n];\n\n` +
  '/** CC0 and public-domain recordings: no credit needed, thanked here. */\n' +
  `export const CC0_THANKS: readonly CreditLine[] = [\n${cc0.map((c) => `  { title: ${q(c.title)}, author: ${q(c.author)}, licence: ${q(c.licence)}, source: ${q(c.source)} },`).join('\n')}\n];\n`;
writeFileSync(join(root, 'src/client/sound/credits.gen.ts'), ts);

const md =
  '# Credits\n\n' +
  'Frontline Atlas is made by Doom956. The art is drawn in code. The sounds and music are recordings and music made by\n' +
  'people, trimmed, levelled and re-encoded for the game (`public/audio/`). The game also lists these in its Credits\n' +
  'section (title screen, and Menu in a game).\n\n' +
  '## Sound and music (CC BY)\n\n' +
  cc.map((c) => `- ${c.line}`).join('\n') +
  '\n\n## Sound and music (CC0 and public domain, with thanks)\n\n' +
  cc0.map((c) => `- ${c.line}`).join('\n') +
  '\n';
writeFileSync(join(root, 'CREDITS.md'), md);
console.log(`credits: ${cc.length} CC BY, ${cc0.length} CC0 or public domain`);

// each file's measured loudness (LUFS): the player evens out variant takes that sit quieter or louder than the pick
const lufs = used.filter((f) => typeof f.loudnessLufs === 'number').map((f) => `  ${q(f.id)}: ${f.loudnessLufs},`);
writeFileSync(
  join(root, 'src/client/sound/loudness.gen.ts'),
  '// Generated by scripts/audio/import.ts from the sound-candidates manifest: do not edit by hand.\n\n' +
    '/** Integrated loudness of each file, LUFS (most are levelled to -16; peak-limited ones sit lower). */\n' +
    `export const LOUDNESS: Readonly<Record<string, number>> = {\n${lufs.join('\n')}\n};\n`,
);
