// GLSL for the map layer (WebGL2). One fullscreen pass: terrain, nations, borders, overlays.
import { GROUND_TINT, GROUND_TINT_ZOOM, TINT_LIFT_MAX, TINT_LIFT_MIN, UNDER_CHROMA, UNDER_DETAIL, UNDER_LUM, UNDER_MID } from './palette';
import { FOG } from '../../sim/config';
import { WATER_FADE_END, WATER_MID } from './terrain';
import type { RGB } from './common';
import { GROUND, SEA_BANDS, type GroundRamp } from './ground';
import { MAP_STYLE_ID, type MapStyle } from './mapStyle';

const rgb = (c: RGB): string => c.map((v) => (v / 255).toFixed(4)).join(', ');

export const MAP_VS = /* glsl */ `#version 300 es
void main() {
  // Fullscreen triangle, no vertex buffers.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/*
 * Tile coordinate of a fragment: t = centre + (fragment - view / 2) / zoom (zoom in device px per tile).
 * Textures:
 *   uOwner   R32UI  owner | fallout << 12 | flash kind << 13 | flash time (0.1 s) << 16   (see tiles.ts)
 *   uTerrId  RG8    terrain id, resource id
 *   uDepth   R8     water distance to land (x10), linear: smooth shores and depth
 *   uTerrCol RGBA8  flat terrain colours, mipmapped: calm whole-map view
 *   uPal     RGBA8  1024 x 12: rows 0-3 owner display colour + fill opacity (alpha), rows 4-7 flags (relation, traitor,
 *            hover), rows 8-11 border colour (palette.ts does the colour work, once per palette change)
 *   uFort    R16UI  owner of the fort covering the tile (0 = none)
 *   uAux     R8     supply class (overlay) or spawn mask (spawn phase)
 *   uTrench  R8     trench level 0..4 (trenchFeed.ts): an earth hatch on dug tiles, a zig-zag line along the edge that
 *                   faces another nation, and far out only a darker border on level 2+
 * Pixel map styles only (render/mapStyle.ts, MAP_STYLE 1-3):
 *   uGround    RGBA8  hill shading, height, variety, ruggedness per tile (ground.ts), linear
 *   uGroundCol RGBA8  the pixel ground's average colours, mipmapped (far view)
 *   uGroundTex RGBA8  this view's ground, one texel per art pixel, drawn by the ground pass (GROUND_PASS, glmap.ts)
 *   uMixA, uMixB, uMixC  RGBA8, linear: terrain shares, moisture and nearness (ground.ts), for real ground's natural
 *                    ground in the ground pass: rounded terrain edges, soft edges between terrains, variety inside them
 */
const ramp4 = (name: string, r: GroundRamp | readonly RGB[]): string =>
  `const vec3 ${name}[${r.length}] = vec3[${r.length}](${r.map((c) => `vec3(${rgb(c)})`).join(', ')});`;

const GROUND_RAMPS = [
  ramp4('GRASS', GROUND.grass),
  ramp4('GRASS_DRY', GROUND.grassDry),
  ramp4('GRASS_LUSH', GROUND.grassLush),
  ramp4('FOREST', GROUND.forest),
  ramp4('HILLS', GROUND.hills),
  ramp4('ROCK', GROUND.rock),
  ramp4('SNOW', GROUND.snow),
  ramp4('SAND', GROUND.sand),
  ramp4('SWAMP', GROUND.swamp),
  ramp4('TUNDRA', GROUND.tundra),
  ramp4('WHEAT', GROUND.wheat),
  ramp4('CROP', GROUND.crop),
  ramp4('SOIL', GROUND.soil),
  ramp4('POOL', GROUND.pool),
  ramp4('SEA', GROUND.sea),
  ramp4('FOAM', GROUND.foam),
].join('\n');

/** The map's fragment shader for a map style (render/mapStyle.ts); MAP_FS is today's. */
export function mapFragmentShader(style: MapStyle): string {
  return MAP_FS_SRC.replace('#define MAP_STYLE 0', `#define MAP_STYLE ${MAP_STYLE_ID[style]}`);
}
/** The ground pass of a pixel map style: the ground alone, one fragment per art pixel (glmap.ts caches it). */
export function groundFragmentShader(style: MapStyle): string {
  return MAP_FS_SRC.replace('#define MAP_STYLE 0', `#define MAP_STYLE ${MAP_STYLE_ID[style]}\n#define GROUND_PASS 1`);
}

const MAP_FS_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
// 0 today, 1 pixel terrain, 2 muted war map, 3 real ground (render/mapStyle.ts)
#define MAP_STYLE 0

uniform usampler2D uOwner;
uniform sampler2D uTerrId;
uniform sampler2D uDepth;
uniform sampler2D uTerrCol;
uniform sampler2D uPal;
uniform usampler2D uFort;
uniform sampler2D uAux;
uniform sampler2D uTrench;
uniform sampler2D uFog;
uniform int uFogOn;
uniform vec2 uFogScale;

uniform vec2 uView;
uniform vec2 uCenter;
uniform float uZoom;
uniform vec2 uMap;
uniform float uTime;
uniform uint uNowDs;
uniform int uAuxMode;
uniform int uShowRes;
uniform int uFortOn;
uniform int uTrenchOn;
uniform vec3 uTerr[9];
uniform vec3 uRes[4];
uniform vec3 uBg;

out vec4 outColor;

uint rawAt(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uMap) - 1);
  return texelFetch(uOwner, p, 0).r;
}
uint ownerAt(ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= int(uMap.x) || p.y >= int(uMap.y)) return 0u;
  return texelFetch(uOwner, p, 0).r & 0xFFFu;
}
// Fog of war, exact per block: 2 = in view, 1 = explored, 0 = never seen (the fog texture, one texel per 16 x 16 block).
int fogAt(ivec2 p) {
  ivec2 sz = textureSize(uFog, 0);
  float v = texelFetch(uFog, clamp(p >> 4, ivec2(0), sz - 1), 0).r;
  return v > 0.7 ? 2 : v > 0.2 ? 1 : 0;
}
// A border is drawn where a neighbour has another owner, except across the edge of two blocks that are not both in
// view: there the owners come from different moments (live and last seen, or two old looks), so the line would be a
// straight fog seam, not a border.
bool borderTo(ivec2 p, ivec2 q, uint o, int fogHere) {
  if (ownerAt(q) == o) return false;
  if (uFogOn == 0 || (p >> 4) == (q >> 4) || q.x < 0 || q.y < 0 || q.x >= int(uMap.x) || q.y >= int(uMap.y)) return true;
  return fogHere == 2 && fogAt(q) == 2;
}
// Bilinear blend of the explored (x) and in-view (y) bits of the 4 nearest blocks: each bit is decoded per block
// before blending, so a block's fade stays inside the blocks that have the bit (never-seen land is dark right from
// its edge, and the owners kept for hidden land never show at full light).
vec2 fogBits(vec2 t) {
  ivec2 sz = textureSize(uFog, 0);
  vec2 b = t / 16.0 - 0.5;
  ivec2 b0 = ivec2(floor(b));
  vec2 w = b - vec2(b0);
  vec2 acc = vec2(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      float v = texelFetch(uFog, clamp(b0 + ivec2(i, j), ivec2(0), sz - 1), 0).r;
      float wt = (i == 0 ? 1.0 - w.x : w.x) * (j == 0 ? 1.0 - w.y : w.y);
      acc += vec2(step(0.2, v), step(0.7, v)) * wt;
    }
  }
  return acc;
}
vec4 pal(uint o, int row) {
  return texelFetch(uPal, ivec2(int(o & 1023u), int(o >> 10u) + row * 4), 0);
}
float hash(ivec2 c, uint salt) {
  uint x = uint(c.x) * 1664525u ^ (uint(c.y) * 1013904223u) ^ (salt * 2654435761u);
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return float(x) * (1.0 / 4294967296.0);
}
// Smooth value noise in 0..1 (fog edges wobble instead of running straight along the block grid).
float vnoise(vec2 p, uint salt) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i, salt), b = hash(i + ivec2(1, 0), salt), c = hash(i + ivec2(0, 1), salt), d = hash(i + ivec2(1, 1), salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
int trenchAt(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uMap) - 1);
  return int(texelFetch(uTrench, p, 0).r * 255.0 + 0.5);
}
// A nation other than o (not nobody, not a tribe): the side trenches face.
bool foeAt(ivec2 p, uint o) {
  uint n = ownerAt(p);
  return n != 0u && n != o && int(pal(n, 1).r * 255.0 + 0.5) != 3;
}
// Distance from the fragment to the nearest edge (or outer corner) of tile ti that faces a foe of o, 1e3 = none; s =
// the position along that edge in tile units (continuous across tiles). Using the nearest edge keeps the trench line
// one unbroken offset curve around staircase borders.
float foeEdge(ivec2 ti, vec2 f, vec2 t, uint o, out float s) {
  float d = 1e3;
  s = 0.0;
  if (foeAt(ti + ivec2(-1, 0), o) && f.x < d) { d = f.x; s = t.y; }
  if (foeAt(ti + ivec2(1, 0), o) && 1.0 - f.x < d) { d = 1.0 - f.x; s = t.y; }
  if (foeAt(ti + ivec2(0, -1), o) && f.y < d) { d = f.y; s = t.x; }
  if (foeAt(ti + ivec2(0, 1), o) && 1.0 - f.y < d) { d = 1.0 - f.y; s = t.x; }
  if (d > 0.7) {
    float k;
    if (foeAt(ti + ivec2(-1, -1), o) && (k = length(f)) < d) { d = k; s = t.x + t.y; }
    if (foeAt(ti + ivec2(1, -1), o) && (k = length(f - vec2(1.0, 0.0))) < d) { d = k; s = t.x - t.y; }
    if (foeAt(ti + ivec2(-1, 1), o) && (k = length(f - vec2(0.0, 1.0))) < d) { d = k; s = t.x - t.y; }
    if (foeAt(ti + ivec2(1, 1), o) && (k = length(f - vec2(1.0))) < d) { d = k; s = t.x + t.y; }
  }
  return d;
}
// Trench symbol at depth d from the facing edge: a line with short teeth pointing at the enemy (the map sign of a
// dug-in line). Level 1 dashed, 2 solid, 3 doubled, 4 doubled and heavier.
float trenchMark(float d, float s, int lvl, float px) {
  float c = 0.36;
  float hw = max(0.04, px * 0.6) * (lvl >= 4 ? 1.6 : 1.0);
  float aa = px * 0.9;
  float a = 1.0 - smoothstep(hw, hw + aa, abs(d - c));
  if (lvl >= 3) a = max(a, 1.0 - smoothstep(hw, hw + aa, abs(d - c - 0.2)));
  float q = abs(fract(s * 2.0) - 0.5) / 2.0;
  float tooth = (1.0 - smoothstep(hw, hw + aa, q)) * step(c - 0.2, d) * step(d, c);
  a = max(a, tooth);
  if (lvl == 1) a *= step(fract(s * 1.25 + 0.2), 0.6);
  return a;
}
// 0..1 coverage of a disc of radius r (tile units) at distance d, antialiased over one device pixel.
float disc(float d, float r, float px) {
  return 1.0 - smoothstep(r - px * 0.7, r + px * 0.7, d);
}
// Distance from p to segment ab.
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Water by depth d (tiles to land, smooth): one smooth fade from the shelf through the middle slate to the open sea.
// Colours and the fade length come from terrain.ts (waterRGB is the same ramp for the minimap and the far texture).
const vec3 WATER_MID = vec3(${rgb(WATER_MID)});
// px = tiles per device pixel: zoomed far out the fade widens (up to 1.8x, so the open sea still starts within
// MAX_DEPTH) and the shelf never shrinks to a coast outline.
vec3 waterAt(float d, float px) {
  vec3 shelf = uTerr[1];
  vec3 sea = uTerr[0];
  d /= clamp(px * 1.5, 1.0, 1.8);
  float g = smoothstep(1.0, ${WATER_FADE_END.toFixed(1)}, d);
  return g < 0.5 ? mix(shelf, WATER_MID, g * 2.0) : mix(WATER_MID, sea, g * 2.0 - 1.0);
}

// Terrain pattern: returns the terrain colour at t; lum = luminance change the pattern makes (nations show it faintly).
vec3 terrainAt(int ter, ivec2 ti, vec2 t, vec2 f, float px, float detail, out float lum) {
  vec3 c = uTerr[ter];
  lum = 0.0;
  if (detail <= 0.0) return c;
  if (ter == 3) {
    // forest: small dark tree crowns, one or two per tile, with a light top edge
    float a = 0.0;
    for (int k = 0; k < 2; k++) {
      vec2 p = vec2(0.28 + 0.44 * hash(ti, uint(11 + k * 7)), 0.3 + 0.42 * hash(ti, uint(17 + k * 5)));
      if (k == 1 && hash(ti, 29u) < 0.45) break;
      float r = 0.2 + 0.07 * hash(ti, uint(31 + k));
      a = max(a, disc(length(f - p), r, px));
    }
    lum = -0.28 * a * detail;
    return c * (1.0 + lum);
  }
  if (ter == 4) {
    // hills: soft domes on a 2.6-tile grid, lit from the upper left
    vec2 q = t / 2.6;
    ivec2 cell = ivec2(floor(q));
    vec2 l = fract(q) - 0.5 + (vec2(hash(cell, 3u), hash(cell, 5u)) - 0.5) * 0.3;
    float r = length(l);
    float dome = 1.0 - smoothstep(0.12, 0.46, r);
    float light = clamp(-(l.x + l.y) * 2.2, -1.0, 1.0);
    lum = (0.22 * light * dome - 0.02) * detail;
    return c * (1.0 + lum);
  }
  if (ter == 5) {
    // mountains: grey; scattered peaks (inverted V) with a light left ridge, a dark right flank and a snow cap
    vec2 q = t / 2.4;
    ivec2 cell = ivec2(floor(q));
    vec2 l = fract(q);
    if (hash(cell, 9u) > 0.72) return c;
    float k = 0.75 + 0.35 * hash(cell, 13u);
    vec2 peak = vec2(0.5 + (hash(cell, 7u) - 0.5) * 0.3, 0.5 - 0.32 * k);
    float pq = px / 2.4;
    float lw = max(0.045, pq * 0.6);
    vec2 bl = vec2(peak.x - 0.4 * k, 0.5 + 0.34 * k);
    vec2 br = vec2(peak.x + 0.4 * k, 0.5 + 0.34 * k);
    float left = 1.0 - smoothstep(lw, lw + pq, seg(l, peak, bl));
    float right = 1.0 - smoothstep(lw, lw + pq, seg(l, peak, br));
    float snow = disc(length(l - peak - vec2(0.0, 0.06)), 0.09 * k, pq);
    lum = (0.3 * max(left, snow) - 0.22 * right) * detail;
    return mix(c * (1.0 + lum), vec3(0.94, 0.95, 0.97), snow * 0.75 * detail);
  }
  if (ter == 6) {
    // desert: fine sand stipple on a 4 x 4 sub-grid
    vec2 q = t * 4.0;
    ivec2 cell = ivec2(floor(q));
    float h = hash(cell, 41u);
    float d = disc(length(fract(q) - 0.5), 0.22, px * 4.0) * step(h, 0.28);
    lum = (h < 0.14 ? -0.1 : 0.07) * d * detail;
    return c * (1.0 + lum);
  }
  if (ter == 7) {
    // swamp: dark olive with short water flecks on a 3 x 3 sub-grid
    vec2 q = t * 3.0;
    ivec2 cell = ivec2(floor(q));
    vec2 l = fract(q) - 0.5;
    float on = step(hash(cell, 53u), 0.32);
    float fleck = (1.0 - smoothstep(0.32, 0.32 + px * 3.0, abs(l.x))) * (1.0 - smoothstep(0.07, 0.07 + px * 3.0, abs(l.y))) * on;
    lum = -0.06 * detail;
    return mix(c * (1.0 + lum), vec3(0.34, 0.47, 0.52), fleck * 0.75 * detail);
  }
  if (ter == 8) {
    // tundra: pale ground with snow dots on a 3 x 3 sub-grid
    vec2 q = t * 3.0;
    ivec2 cell = ivec2(floor(q));
    vec2 p = vec2(0.3, 0.3) + 0.4 * vec2(hash(cell, 61u), hash(cell, 67u));
    float d = disc(length(fract(q) - p), 0.17, px * 3.0) * step(hash(cell, 71u), 0.4);
    lum = 0.06 * d * detail;
    return mix(c, vec3(0.98, 0.99, 1.0), d * 0.85 * detail);
  }
  return c; // plains: smooth
}

// Deposit marking on the tile itself (close zoom): iron = grey rocks, oil = black pool, fertile = golden furrows.
vec4 depositAt(int res, ivec2 ti, vec2 f, float px) {
  if (res == 1) {
    float a = 0.0;
    for (int k = 0; k < 3; k++) {
      vec2 p = vec2(0.22 + 0.56 * hash(ti, uint(83 + k)), 0.22 + 0.56 * hash(ti, uint(89 + k)));
      a = max(a, disc(length(f - p), 0.15 + 0.05 * float(k == 0), px));
    }
    return vec4(uRes[1], a * 0.95);
  }
  if (res == 2) {
    float a = disc(length((f - vec2(0.5, 0.55)) * vec2(1.0, 1.35)), 0.3, px);
    return vec4(uRes[2], a * 0.9);
  }
  if (res == 3) {
    float s = fract((f.x - f.y) * 3.0);
    float a = 1.0 - smoothstep(0.32, 0.32 + px * 3.0, abs(s - 0.5));
    return vec4(uRes[3], a * 0.7);
  }
  return vec4(0.0);
}

#if MAP_STYLE != 0
// ================================================================ pixel ground (map styles 1-3)
// The ground is drawn in art pixels: P per tile (a power of two, so the grid only changes at a few zooms), each one
// sampled at its centre, so every pattern is crisp and pixel-snapped at any zoom. Features live in tile space (a tree,
// a dune, a peak stay put while you zoom); only how finely they are drawn changes. Colours come in 4-tone ramps lit
// from the top left (render/ground.ts), like the unit art. Far out the mipmapped average colours take over.
uniform sampler2D uGround;
uniform sampler2D uGroundCol;
uniform sampler2D uGroundTex;
uniform ivec2 uGOrigin;
uniform float uP;
uniform float uDpr;
uniform float uNearOn;

${GROUND_RAMPS}

const vec2 LIGHT = vec2(-0.7071, -0.7071); // towards the light: top left

// Distance (tile units, square corners) from in-tile position f to the nearest edge of tile ti that borders another
// owner, looking only at edges closer than maxW; 9.0 = none.
float edgeDist(ivec2 ti, vec2 f, uint o, int fogHere, float maxW) {
  float d = 9.0;
  bool l = f.x < maxW, r = 1.0 - f.x < maxW, u = f.y < maxW, dn = 1.0 - f.y < maxW;
  if (l && borderTo(ti, ti + ivec2(-1, 0), o, fogHere)) d = min(d, f.x);
  if (r && borderTo(ti, ti + ivec2(1, 0), o, fogHere)) d = min(d, 1.0 - f.x);
  if (u && borderTo(ti, ti + ivec2(0, -1), o, fogHere)) d = min(d, f.y);
  if (dn && borderTo(ti, ti + ivec2(0, 1), o, fogHere)) d = min(d, 1.0 - f.y);
  if (l && u && borderTo(ti, ti + ivec2(-1, -1), o, fogHere)) d = min(d, max(f.x, f.y));
  if (r && u && borderTo(ti, ti + ivec2(1, -1), o, fogHere)) d = min(d, max(1.0 - f.x, f.y));
  if (l && dn && borderTo(ti, ti + ivec2(-1, 1), o, fogHere)) d = min(d, max(f.x, 1.0 - f.y));
  if (r && dn && borderTo(ti, ti + ivec2(1, 1), o, fogHere)) d = min(d, max(1.0 - f.x, 1.0 - f.y));
  return d;
}

// Ordered dither threshold of an art pixel (4 x 4 Bayer), 0..1.
float bayer4(ivec2 p) {
  int i = (p.y & 3) * 4 + (p.x & 3);
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}
// Tone index 0..3 of a ramp for v in 0..1: hard steps, dithered over a narrow band at each step (dith 0..1).
int toneIdx(float v, float dth, float dith) {
  return clamp(int(floor(v * 4.0 + (dth - 0.5) * dith)), 0, 3);
}
#define TONE(R, v) R[toneIdx(v, dth, 0.3)]

// Real ground's nation tint (palette.ts groundTint, the same maths): the ground's own colour mostly out, the nation's
// hue in at the ground's brightness, so a red nation is red on grass, forest, sand or snow (a plain blend goes brown).
// k = ground colour kept, nation colour added, broad brightness kept, small detail kept.
const vec4 TINT_NEAR = vec4(${GROUND_TINT.near.map((v) => v.toFixed(3)).join(', ')});
const vec4 TINT_FAR = vec4(${GROUND_TINT.far.map((v) => v.toFixed(3)).join(', ')});
const vec4 TINT_BAND = vec4(${GROUND_TINT.band.map((v) => v.toFixed(3)).join(', ')});
const vec4 TINT_TRIBE = vec4(${GROUND_TINT.tribe.map((v) => v.toFixed(3)).join(', ')});
vec3 tintGround(vec3 g, float gy, float avgY, vec3 oc, vec4 k) {
  float oy = max(0.04, dot(oc, vec3(0.299, 0.587, 0.114)));
  float y = oy + (avgY - oy) * k.z + (gy - avgY) * k.w;
  float lift = clamp(y / oy, ${TINT_LIFT_MIN.toFixed(2)}, ${TINT_LIFT_MAX.toFixed(2)});
  return clamp(vec3(y) + (oc - oy) * lift * k.y + (g - gy) * k.x, 0.0, 1.0);
}

#ifdef GROUND_PASS
// Relief of rugged ground (ridged noise) and of rolling ground, in 0..1 at tile position p.
float hRidge(vec2 p) {
  float a = 1.0 - abs(vnoise(p / 1.9, 71u) * 2.0 - 1.0);
  float b = 1.0 - abs(vnoise(p / 0.85, 73u) * 2.0 - 1.0);
  return a * 0.68 + b * 0.32;
}
float hRoll(vec2 p) {
  return vnoise(p / 1.5, 75u) * 0.65 + vnoise(p / 0.7, 77u) * 0.35;
}

// A small detail sprite on a sparse grid (cell tile units): 1 when art pixel centre q is the lit pixel of the cell's
// sprite, -1 on its shadow pixel (one pixel down and right), 0 elsewhere. density = share of cells with one.
float speck(vec2 q, float cell, float density, uint salt, float P) {
  vec2 cq = q / cell;
  ivec2 c = ivec2(floor(cq));
  if (hash(c, salt) >= density) return 0.0;
  vec2 at = (vec2(c) + 0.2 + 0.6 * vec2(hash(c, salt + 1u), hash(c, salt + 2u))) * cell;
  ivec2 a = ivec2(floor(at * P));
  ivec2 me = ivec2(floor(q * P));
  if (me == a) return 1.0;
  if (me == a + ivec2(1, 1) || (P >= 8.0 && me == a + ivec2(0, 1))) return -1.0;
  return 0.0;
}

#if MAP_STYLE == 3
// Real ground draws natural ground: terrain edges along rounded lines, soft edges between terrains (lone trees out from
// a forest, scree at a mountain's foot, grass at a desert's edge), variety inside a terrain (drier and lusher grass,
// meadows, clearings, darker old woods, now and then a tiny pond). Only how the ground looks: a tile's terrain and what
// it does in the game never change, and nothing here looks like a road or a river.
#define NATURAL 1
uniform sampler2D uMixA;
uniform sampler2D uMixB;
uniform sampler2D uMixC;
#endif
// natural ground, set by groundAt for the pixel being drawn: how near forest, desert, mountains and hills are (0..1,
// blurred over about four tiles) and the moisture (0..1)
vec4 gNear = vec4(0.0);
float gMoist = 0.5;

// Grass in the tone for v, dry (yellower), plain or lush (greener) by moisture m.
vec3 grassTone(float v, float dth, float m) {
  int i = toneIdx(v, dth, 0.3);
  return m < 0.3 ? GRASS_DRY[i] : m > 0.68 ? GRASS_LUSH[i] : GRASS[i];
}
// The moisture at q: its slow field, the edges of its patches broken into wandering lines by finer noise (a hair of
// dither only, so no checkerboard bands), drier towards a desert.
float moistAt(vec2 q, float dth) {
  return gMoist + (vnoise(q / 1.4, 431u) - 0.5) * 0.16 + (vnoise(q / 4.0, 433u) - 0.5) * 0.12 + (dth - 0.5) * 0.015 - gNear.g * 0.45;
}
// Tree crowns on the forest's grid (a crown about 4 art pixels across: one per tile when art pixels are coarse, two per
// tile each way when fine), lit on the upper left. density = share of the grid's cells with a tree; dark = how much
// darker the crowns are. Returns the crown colour with a = 1 on a crown; else a = -1 in a crown's shadow (down and to
// the right of it), 0 in the open.
vec4 treeAt(vec2 q, float P, float density, float dth, float sh, float dark) {
  float tc = P >= 8.0 ? 2.0 : 1.0;
  vec2 c2 = q * tc;
  ivec2 c0 = ivec2(floor(c2 - 0.5));
  float best = 9.0;
  vec2 rel = vec2(0.0);
  bool shade = false;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      ivec2 c = c0 + ivec2(i, j);
      if (density < 1.0 && hash(c, 109u) >= density) continue;
      vec2 ctr = vec2(c) + 0.5 + (vec2(hash(c, 101u), hash(c, 103u)) - 0.5) * 0.5;
      float r = 0.66 + 0.2 * hash(c, 107u);
      vec2 l = (c2 - ctr) / r;
      float d = length(l);
      if (d < best) { best = d; rel = l; }
      if (length(l - vec2(0.35, 0.45)) < 0.95) shade = true;
    }
  }
  if (best > 1.0) return vec4(0.0, 0.0, 0.0, shade ? -1.0 : 0.0);
  float lit = dot(rel, LIGHT);
  return vec4(TONE(FOREST, 0.6 + 0.3 * lit - 0.18 * best * best + sh * 0.6 - dark), 1.0);
}

// The land at art pixel centre q (tile units): returns its colour. ter = the (edge-warped) terrain, S = hill shading
// -1..1, hgt = height 0..1, vary = slow variety 0..1, ap = art pixel coords, P = art pixels per tile. Tone values sit
// at the middle of a ramp step (0.625 = the base tone), so flat ground is one clean colour and only light, shade and
// the small details step it up or down.
vec3 landAt(int ter, vec2 q, float S, float hgt, float vary, ivec2 ap, float P) {
  float dth = bayer4(ap);
  float sh = clamp(S, -1.0, 1.0) * 0.26;
  if (ter == 3) {
#ifdef NATURAL
    // natural forest: a little thinner at its very edge (fewer cells hold a tree), small glades that stay wooded (a
    // forest tile always reads as forest), darker old woods in wet country; the forest floor shows where trees are missing
    float dens = mix(0.66, 1.0, smoothstep(0.3, 0.62, gNear.r));
    float clr = vnoise(q / 2.2, 411u);
    dens *= 1.0 - 0.5 * smoothstep(0.74, 0.8, clr);
    float old = gMoist > 0.58 && vnoise(q / 7.0, 413u) > 0.55 ? 0.12 : 0.0;
    vec4 tr = treeAt(q, P, dens, dth, sh, old);
    if (tr.a > 0.0) return tr.rgb;
    if (dens > 0.9) return FOREST[0];
    return grassTone(0.45 + sh - (tr.a < 0.0 ? 0.25 : 0.0), dth, moistAt(q, dth) + 0.15);
#endif
    // forest: packed tree crowns lit on the upper left, dark gaps between them; a crown is about 4 art pixels across
    // (one per tile when art pixels are coarse, two per tile each way when fine), so trees read at every zoom
    float tc = P >= 8.0 ? 2.0 : 1.0;
    vec2 c2 = q * tc;
    ivec2 c0 = ivec2(floor(c2 - 0.5));
    float best = 9.0;
    vec2 rel = vec2(0.0);
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        ivec2 c = c0 + ivec2(i, j);
        vec2 ctr = vec2(c) + 0.5 + (vec2(hash(c, 101u), hash(c, 103u)) - 0.5) * 0.5;
        float r = 0.66 + 0.2 * hash(c, 107u);
        vec2 l = (c2 - ctr) / r;
        float d = length(l);
        if (d < best) { best = d; rel = l; }
      }
    }
    if (best > 1.0) return FOREST[0];
    float lit = dot(rel, LIGHT);
    return TONE(FOREST, 0.6 + 0.3 * lit - 0.18 * best * best + sh * 0.6);
  }
  if (ter == 4) {
    // hills: round knolls on a staggered grid, lit on the upper left with a shadow on the lower right; the front ones
    // (lower on screen) overlap the ones behind
#ifdef NATURAL
    // near a forest a few trees stand on the hills
    float td = smoothstep(0.1, 0.6, gNear.r) * 0.4;
    vec4 htr = td > 0.0 ? treeAt(q, P, td, dth, sh, 0.0) : vec4(0.0);
    if (htr.a > 0.0) return htr.rgb;
#endif
    vec2 cs = P >= 8.0 ? vec2(1.5, 1.1) : vec2(2.2, 1.6);
    float row = floor(q.y / cs.y);
    for (int j = 1; j >= 0; j--) {
      float r = row + float(j) - 0.0;
      for (int i = -1; i <= 1; i++) {
        float ox = 0.5 * mod(r, 2.0);
        float cxi = floor(q.x / cs.x - ox) + float(i);
        ivec2 c = ivec2(int(cxi), int(r));
        if (hash(c, 201u) > 0.5) continue;
        vec2 ctr = vec2((cxi + ox + 0.5 + (hash(c, 203u) - 0.5) * 0.4) * cs.x, (r + 0.35) * cs.y);
        vec2 rad = vec2(0.55, 0.42) * cs * (0.8 + 0.4 * hash(c, 205u));
        vec2 l = (q - ctr) / rad;
        float d = dot(l, l);
        if (d > 1.0) continue;
        float lit = dot(normalize(l + vec2(0.0001)), LIGHT) * sqrt(d);
        float v = 0.6 + 0.3 * lit + sh * 0.5;
        if (d > 0.7 && l.y > 0.2 && l.x > -0.3) v -= 0.25; // the foot of the lower edge in shade
        return TONE(HILLS, v);
      }
    }
    float v = 0.5 + sh + 0.25 * speck(q, 0.9, 0.3, 211u, P);
#ifdef NATURAL
    // scree at a mountain's foot, a tree's shadow
    float scr = smoothstep(0.1, 0.55, gNear.b) * 0.5;
    if (scr > 0.0) { float k = speck(q, 0.5, scr, 441u, P); if (k != 0.0) return TONE(ROCK, 0.625 + 0.25 * k + sh); }
    if (htr.a < 0.0) v -= 0.25;
#endif
    return TONE(HILLS, v);
  }
  if (ter == 5) {
    // mountains: peaks drawn as pixel sprites seen a little from the side: a triangle with its lit left face and dark
    // right face, a snow cap on the high ranges; peaks lower on screen stand in front; rock between them
    // Each row of cells slides sideways by its own random amount (not a fixed half-cell stagger), and every peak varies
    // in place, height, width and lean (left and right flanks of their own length), now and then with a lower second
    // summit on one shoulder, so a dense range reads as a jumble of peaks, not rows of the same triangle. The ranges
    // keep every peak inside the cells searched (its foot within its own row, at most one cell either side of the
    // pixel's cell, up to two rows below), so no peak is ever cut straight.
    vec2 cs = P >= 8.0 ? vec2(1.9, 1.15) : vec2(2.8, 1.7);
    float row = floor(q.y / cs.y);
    float cap = clamp((hgt - 0.55) * 1.6, 0.0, 0.45);
    for (int j = 2; j >= 0; j--) {
      float r = row + float(j);
      float ox = hash(ivec2(int(r), 17), 315u);
      for (int i = -1; i <= 1; i++) {
        float cxi = floor(q.x / cs.x - ox) + float(i);
        ivec2 c = ivec2(int(cxi), int(r));
        // peaks gather where the range is high: fewer on its low edges, rock showing between
        if (hash(c, 301u) > 0.15 + 0.55 * smoothstep(0.45, 0.85, hgt)) continue;
        float k = 0.55 + 0.85 * hash(c, 303u) * hash(c, 309u) + 0.25 * smoothstep(0.5, 0.9, hgt);
        float ax = (cxi + ox + 0.5 + (hash(c, 305u) - 0.5) * 0.6) * cs.x;
        float by = (r + 0.7 + 0.3 * hash(c, 313u)) * cs.y;
        float ht = cs.y * min(2.6, 1.45 * k * (0.75 + 0.5 * hash(c, 317u)));
        float ay = by - ht;
        if (q.y < ay || q.y > by) continue;
        float fy = (q.y - ay) / ht; // 0 at the tip, 1 at the base
        float wl = cs.x * min(1.0, k * (0.44 + 0.22 * hash(c, 319u))) * fy;
        float wr = cs.x * min(1.0, k * (0.44 + 0.22 * hash(c, 321u))) * fy;
        float dx = q.x - ax;
        bool inside = dx < 0.0 ? -dx <= wl : dx <= wr;
        // a shoulder: a lower second summit on one flank, its own small triangle
        float sh2 = hash(c, 323u);
        bool shoulder = false;
        if (!inside && sh2 < 0.4) {
          float sx = ax + (sh2 < 0.2 ? -1.0 : 1.0) * cs.x * min(0.55, k * 0.35);
          float sy = ay + ht * 0.38;
          float sfy = (q.y - sy) / (by - sy);
          float sdx = q.x - sx;
          float sw = cs.x * min(0.48, k * 0.3) * sfy;
          if (sfy >= 0.0 && abs(sdx) <= sw) { inside = true; shoulder = true; dx = sdx; fy = sfy; wl = wr = sw; }
        }
        if (!inside) continue;
        float side = dx < 0.0 ? dx / max(wl, 0.001) : dx / max(wr, 0.001); // -1 left edge .. 1 right edge
        // the faces: lit left, a light ridge line just left of the crest, dark right, darkest at the right foot
        float v = dx < 0.0 ? 0.78 + 0.1 * step(-0.25, side) : 0.42 - 0.14 * step(0.6, side) * step(0.5, fy);
        if (!shoulder && fy < cap + (hash(c, 307u) - 0.5) * 0.16) return SNOW[dx < 0.0 ? 3 : 1];
        return TONE(ROCK, v + sh * 0.3 - (shoulder ? 0.08 : 0.0));
      }
    }
    return TONE(ROCK, 0.4 + sh + 0.25 * speck(q, 0.7, 0.35, 311u, P));
  }
  if (ter == 6) {
    // desert: dune ridges where the sand runs deep (a long lit windward side, a crest, a short dark lee), flat sand
    // with a few pebbles between
    vec2 dir = vec2(0.9138, 0.4061);
    float u = dot(q, dir) * 0.42 + vnoise(q / 4.5, 81u) * 1.5;
    float s = fract(u);
    float amp = vnoise(q / 2.6, 83u) * 0.7 + vnoise(q / 7.0, 85u) * 0.3;
    float v = 0.625 + sh;
#ifdef NATURAL
    // natural desert: dunes only where the sand runs deep; at its edges dry grass creeps in, in patches that thin out
    // towards the middle; scree near mountains
    float deep = smoothstep(0.5, 0.92, gNear.g);
    amp *= deep;
    if (vnoise(q / 1.2, 421u) > 0.45 + 0.55 * deep + (dth - 0.5) * 0.08) return grassTone(0.5 + sh, dth, 0.2);
    float scr = smoothstep(0.1, 0.55, gNear.b) * 0.45;
    if (scr > 0.0) { float k = speck(q, 0.5, scr, 443u, P); if (k != 0.0) return TONE(ROCK, 0.625 + 0.25 * k + sh); }
#endif
    if (amp > 0.5) {
      if (s > 0.9) v -= 0.25;
      else if (s > 0.86) v += 0.25;
    }
    v += 0.25 * speck(q, 1.1, 0.18, 221u, P);
    return TONE(SAND, v);
  }
  if (ter == 7) {
    // swamp: dark olive with standing pools (a light rim on their far edge) and reed tufts
    vec2 rq = mat2(0.8, -0.6, 0.6, 0.8) * q;
    float pv = vnoise(rq / 0.8, 91u);
    if (pv > 0.62) {
      float rim = vnoise((rq + vec2(0.14, 0.98) * (0.7 / P)) / 0.8, 91u);
      return rim <= 0.62 ? POOL[3] : POOL[1];
    }
    float v = 0.625 + sh + 0.25 * speck(q, 0.6, 0.45, 231u, P);
    return TONE(SWAMP, v);
  }
  if (ter == 8) {
    // tundra: pale ground with lichen specks and drifts of snow
    vec2 rq = mat2(0.8, -0.6, 0.6, 0.8) * q; // turned, so the drifts do not line up with the tile grid
    float sv = vnoise(rq / 1.6, 95u) * 0.7 + vnoise(rq / 3.5, 97u) * 0.3;
    if (sv > 0.69) return TONE(SNOW, 0.6 + sh);
    float v = 0.625 + sh - 0.25 * abs(speck(q, 1.1, 0.25, 241u, P));
    return TONE(TUNDRA, v);
  }
  // plains: grass with tufts, and in the farmed stretches a patchwork of fields (wheat, crops, now and then ploughed
  // soil): blocks of 4 x 3 tiles cut once each way at random, so the fields differ in size and never line up as bricks
  float v = 0.625 + sh;
#ifdef NATURAL
  // natural plains: lone trees out from a forest's edge, scree at a mountain's foot, a tiny pond now and then where it
  // is wet (a few art pixels: decoration, not water you could sail), lighter meadows, the grass drier or lusher
  float m = moistAt(q, dth);
  float ptd = smoothstep(0.1, 0.5, gNear.r) * 0.3;
  vec4 ptr = ptd > 0.0 ? treeAt(q, P, ptd, dth, sh, 0.0) : vec4(0.0);
  if (ptr.a > 0.0) return ptr.rgb;
  float pscr = smoothstep(0.1, 0.55, gNear.b) * 0.5;
  if (pscr > 0.0) { float k = speck(q, 0.5, pscr, 445u, P); if (k != 0.0) return TONE(ROCK, 0.625 + 0.25 * k + sh); }
  if (P >= 4.0 && m > 0.45) {
    vec2 pq = q / 6.0;
    ivec2 pc = ivec2(floor(pq));
    if (hash(pc, 451u) < 0.12) {
      vec2 ctr = (vec2(pc) + 0.25 + 0.5 * vec2(hash(pc, 453u), hash(pc, 455u))) * 6.0;
      vec2 rr = vec2(0.32 + 0.18 * hash(pc, 457u), 0.2 + 0.1 * hash(pc, 459u));
      vec2 l = (q - ctr) / rr;
      float d = dot(l, l);
      if (d < 1.0) return l.y < -0.35 ? POOL[1] : POOL[2];
      if (d < 1.7 && l.y > 0.1) v -= 0.25; // a darker bank below it
    }
  }
  // meadows: patches with more light specks (flowers, tall grass), not a lighter wash
  float meadow = smoothstep(0.62, 0.72, vnoise(q / 4.5, 401u));
  if (ptr.a < 0.0) v -= 0.25;
#endif
  float farm = smoothstep(0.5, 0.75, vary);
  if (farm > 0.0) {
    vec2 bq = q / vec2(4.0, 3.0);
    ivec2 bc = ivec2(floor(bq));
    vec2 bl = fract(bq);
    float cx = 0.3 + 0.4 * hash(bc, 141u);
    float cy = 0.3 + 0.4 * hash(bc, 142u);
    ivec2 part = ivec2(bl.x < cx ? 0 : 1, bl.y < cy ? 0 : 1);
    ivec2 fc = bc * 2 + part;
    if (hash(fc, 143u) < farm * 0.8) {
      float k = hash(fc, 145u);
      // a one-pixel hedge on the field's top and left edges when close
      vec2 lo = vec2(part.x == 0 ? 0.0 : cx, part.y == 0 ? 0.0 : cy) * vec2(4.0, 3.0);
      vec2 fl = bl * vec2(4.0, 3.0) - lo;
      if (P >= 8.0 && (fl.x < 1.0 / P || fl.y < 1.0 / P)) return TONE(GRASS, 0.375 + sh);
      float fv = v;
      if (P >= 8.0 && fract(fl.y * 2.5 + k) < 0.3) fv -= 0.25;
      if (k < 0.45) return TONE(WHEAT, fv);
      if (k < 0.85) return TONE(CROP, fv);
      return TONE(SOIL, fv);
    }
  }
#ifdef NATURAL
  v += 0.25 * speck(q, 0.7, 0.4 + 0.45 * meadow, 251u, P);
  if (meadow > 0.0) v += 0.25 * max(0.0, speck(q, 0.45, 0.5 * meadow, 253u, P));
  return grassTone(v, dth, m);
#endif
  v += 0.25 * speck(q, 0.7, 0.4, 251u, P);
#ifdef NATURAL
#else
  return TONE(GRASS, v);
#endif
}

// The sea at art pixel centre q: depth bands with dithered edges, wave marks that come and go, shore foam.
// d = tiles to land (smooth, 0.5 at the coast line).
vec3 seaAt(vec2 q, float d, ivec2 ap, float P) {
  float dth = bayer4(ap);
  float dj = d + (dth - 0.5) * 0.7 + (vnoise(q / 3.0, 151u) - 0.5) * 1.6;
  int band = dj < ${SEA_BANDS[0].toFixed(2)} ? 0 : dj < ${SEA_BANDS[1].toFixed(2)} ? 1 : dj < ${SEA_BANDS[2].toFixed(2)} ? 2 : dj < ${SEA_BANDS[3].toFixed(2)} ? 3 : 4;
  vec3 c = SEA[band];
  // shore foam: one art pixel of surf on the coast line, and a broken second line just off it that drifts
  float a1 = 0.5 + 1.0 / P;
  if (d < a1) return mix(c, FOAM[3], 0.62);
  float a2 = 0.5 + max(2.0 / P, 0.35);
  if (P >= 4.0 && d < a2 + 1.0 / P && d >= a2 && vnoise(q * 1.6 + vec2(uTime * 0.12, 0.0), 157u) > 0.58) return mix(c, FOAM[2], 0.35);
  // wave marks: short crests of a few art pixels on a staggered grid, each showing for a while then resting
  if (d > 2.5 && P >= 4.0) {
    vec2 cell = P >= 8.0 ? vec2(3.2, 1.7) : vec2(4.4, 2.4);
    vec2 wq = q / cell;
    float row = floor(wq.y);
    wq.x += 0.5 * mod(row, 2.0);
    ivec2 wc = ivec2(floor(wq));
    float wh = hash(wc, 161u);
    float phase = fract(uTime / 9.0 + wh * 3.7);
    if (wh < (P >= 8.0 ? 0.4 : 0.28) && phase < 0.7) {
      vec2 l = (fract(wq) - 0.5) * cell; // tile units from the cell centre
      float hw = max(0.3 + 0.25 * hash(wc, 163u), 1.6 / P);
      float x = l.x / hw;
      float y = l.y + (0.12 + 0.5 / P) * (1.0 - x * x); // a crest: the middle a pixel higher than the ends
      if (abs(x) < 1.0 && abs(y) < 0.5 / P) return mix(c, FOAM[0], band <= 1 ? 0.7 : 0.55);
    }
  }
  return c;
}
#endif
#endif

#ifdef GROUND_PASS
// The ground of art pixel ap at P art pixels per tile: sea or land, the beach strip, terrain edges that wander.
vec3 groundAt(ivec2 ap, float P) {
  vec2 tq = (vec2(ap) + 0.5) / P;
  if (tq.x < 0.0 || tq.y < 0.0 || tq.x >= uMap.x || tq.y >= uMap.y) return uBg;
  ivec2 ti = ivec2(floor(tq));
  int ter = int(texelFetch(uTerrId, ti, 0).r * 255.0 + 0.5);
  float landDistQ = texture(uDepth, tq / uMap).r * 25.5;
  if (ter <= 1) return seaAt(tq, landDistQ, ap, P);
  vec4 gd = texture(uGround, tq / uMap);
#ifdef NATURAL
  // Which terrain to draw: each terrain's share sampled smoothly between tiles (full at a tile's centre, half way at
  // its edge), nudged by slow noise and a fine dither, the largest wins. Edges follow rounded, wandering lines in whole
  // art pixels instead of the tile staircase; a lone tile of forest keeps its place.
  vec2 uv = tq / uMap;
  vec4 ma = texture(uMixA, uv);
  vec4 mb = texture(uMixB, uv);
  gNear = texture(uMixC, uv);
  gMoist = mb.a;
  float dth = bayer4(ap);
  float n1 = vnoise(tq * 0.75, 181u) - 0.5;
  float n2 = vnoise(tq * 1.7, 183u) - 0.5;
  float wa = n1 * 0.36 + n2 * 0.18;
  float wb = n2 * 0.36 - n1 * 0.18;
  int gter = 2;
  float best = mb.b + (dth - 0.5) * 0.1;
  float sc;
  sc = ma.r + wa; if (sc > best) { best = sc; gter = 3; }
  sc = ma.g - wb; if (sc > best) { best = sc; gter = 6; }
  sc = ma.b + wb; if (sc > best) { best = sc; gter = 5; }
  sc = ma.a - wa; if (sc > best) { best = sc; gter = 4; }
  sc = mb.r - wa * 0.8; if (sc > best) { best = sc; gter = 7; }
  sc = mb.g + wb * 0.8; if (sc > best) { best = sc; gter = 8; }
  vec3 c = landAt(gter, tq, (gd.r - 0.5) * 2.0, gd.g, gd.b, ap, P);
  // the coast: a sand beach on flat land, a narrow dark one by forest and swamp, rocky shore by hills and mountains;
  // its width wanders
  if (landDistQ > 0.12) {
    float edge = landDistQ + (vnoise(tq * 1.3, 461u) - 0.5) * 0.3;
    float sh = (gd.r - 0.5) * 0.52;
    if (ma.b + ma.a > 0.45) {
      if (edge > 0.22) c = ROCK[toneIdx(0.5 + sh + 0.25 * speck(tq, 0.4, 0.5, 463u, P), dth, 0.3)];
    } else if (gter == 3 || gter == 7) {
      if (edge > 0.3) c = SAND[1];
    } else if (edge > 0.18) c = SAND[toneIdx(0.625 + sh, dth, 0.3)];
  }
  return c;
#else
  // terrain edges wander by up to half a tile (land to land only), so forests and fields do not end in staircases
  vec2 wq = tq + (vec2(vnoise(tq * 1.4, 171u), vnoise(tq * 1.4, 173u)) - 0.5) * 0.9;
  ivec2 wi = clamp(ivec2(floor(wq)), ivec2(0), ivec2(uMap) - 1);
  int wter = int(texelFetch(uTerrId, wi, 0).r * 255.0 + 0.5);
  int gter = wter > 1 ? wter : ter;
  vec3 c = landAt(gter, tq, (gd.r - 0.5) * 2.0, gd.g, gd.b, ap, P);
  // a strip of beach on land at the coast
  if (landDistQ > 0.2 && gter != 6 && gter != 5) c = mix(c, SAND[2], 0.8);
  return c;
#endif
}

// Ground pass: one fragment per art pixel of the view (glmap.ts sizes the target and sets uGOrigin, uP)
void main() {
  outColor = vec4(groundAt(uGOrigin + ivec2(floor(gl_FragCoord.xy)), uP), 1.0);
}
#else
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
  vec2 t = uCenter + (frag - uView * 0.5) / uZoom;
  if (t.x < 0.0 || t.y < 0.0 || t.x >= uMap.x || t.y >= uMap.y) {
    outColor = vec4(uBg, 1.0);
    return;
  }
  ivec2 ti = ivec2(floor(t));
  vec2 f = t - vec2(ti);
  vec2 uv = t / uMap;
  float px = 1.0 / uZoom; // tile units per device pixel
  float detail = smoothstep(3.0, 7.0, uZoom);

  vec2 tr = texelFetch(uTerrId, ti, 0).rg * 255.0;
  int ter = int(tr.r + 0.5);
  int res = int(tr.g + 0.5);
  bool water = ter <= 1;
  // fog of war: one texel per 16 x 16 block (255 in view, 110 explored, 0 never seen); smoothstep on the blended
  // bits gives soft, rounded edges inside the seen / live blocks instead of block squares
  float fogSeen = 1.0;
  float fogLive = 1.0;
  int fogHere = 2;
  if (uFogOn == 1) {
    // a gentle wobble (up to ~3 tiles) so the edges of the block grid read as a natural haze, not straight lines
    vec2 wob = (vec2(vnoise(t / 9.0, 61u), vnoise(t / 9.0, 67u)) - 0.5) * 6.0;
    vec2 fb = fogBits(t + wob);
    fogSeen = smoothstep(0.5, 1.0, fb.x);
    fogLive = smoothstep(0.5, 1.0, fb.y);
    fogHere = fogAt(ti);
  }
  bool live = fogLive > 0.5;

  // ---- terrain
  float lum = 0.0;
  vec3 col;
#if MAP_STYLE != 0
  // art pixels per tile: a power of two that keeps an art pixel 1.25 to 2.5 CSS px wide (the units' mid-zoom scale),
  // worked out once on the CPU (glmap.ts artPixelsPerTile) so this pass and the ground pass agree exactly
  float zc = uZoom / uDpr;
  float P = uP;
  ivec2 ap = ivec2(floor(t * P));
  vec2 tq = (vec2(ap) + 0.5) / P;
  vec2 fq = tq - vec2(ti);
  // the pixel ground (drawn by the ground pass, one texel per art pixel) fades in over the far view's average colours
  // (mipmapped: calm, no shimmer far out)
  // (uNearOn 0: no ground pass to show, the far colours at every zoom: the light map, or while the ground is built)
  float nearG = smoothstep(2.0, 3.2, zc) * uNearOn;
  vec3 farCol = texture(uGroundCol, uv).rgb;
  vec3 gcol = farCol;
  if (nearG > 0.0) gcol = mix(farCol, texelFetch(uGroundTex, clamp(ap - uGOrigin, ivec2(0), textureSize(uGroundTex, 0) - 1), 0).rgb, nearG);
  col = gcol;
#if MAP_STYLE == 2
  // muted war map: the pixel ground pulled towards today's calm flat colours (quieter, still lit and textured)
  if (!water) col = mix(mix(texture(uTerrCol, uv).rgb, farCol, 0.5), col, 0.55);
#endif
#else
  float near = smoothstep(1.2, 2.6, uZoom);
  vec3 flat_ = texture(uTerrCol, uv).rgb;
  // tiles to land, smooth (0 on land)
  float landDist = texture(uDepth, uv).r * 25.5;
  if (water) {
    float d = landDist;
    float k = smoothstep(1.0, 6.0, d);
    vec3 wc = waterAt(d, px);
    wc += vec3(0.02, 0.03, 0.035) * (1.0 - smoothstep(0.55, 1.5, d)); // quiet shoreline
    if (detail > 0.0) {
      // faint wave dashes in open water
      vec2 q = t * vec2(1.0, 2.0) / 3.0;
      ivec2 cell = ivec2(floor(q));
      vec2 l = fract(q) - 0.5;
      float on = step(hash(cell, 97u), 0.18) * k;
      float wave = (1.0 - smoothstep(0.22, 0.22 + px, abs(l.x))) * (1.0 - smoothstep(0.03, 0.03 + px * 0.7, abs(l.y + 0.08 * cos(l.x * 9.0))));
      wc += vec3(0.05, 0.06, 0.07) * wave * on * detail;
    }
    col = wc; // the depth style at every zoom (the flat texture's water steps per whole tile)
  } else {
    vec3 tc = terrainAt(ter, ti, t, f, px, detail, lum);
    // soft sandy shore on land tiles next to water
    float shore = smoothstep(0.08, 0.45, landDist);
    tc = mix(tc, vec3(0.8, 0.77, 0.66), shore * 0.25);
    col = mix(flat_, tc, near);
  }

#endif
  // ---- deposits on unowned land (close zoom)
  uint raw = rawAt(ti);
  uint o = raw & 0xFFFu;
  if (res > 0 && detail > 0.0 && fogSeen > 0.5) {
    vec4 dep = depositAt(res, ti, f, px);
    if (o == 0u) col = mix(col, dep.rgb, dep.a * detail);
  }

  // ---- nations: a calm, translucent colour over a quiet copy of the terrain
  vec4 flags = vec4(0.0);
  if (o != 0u) {
    vec4 pc = pal(o, 0);
    vec3 oc = pc.rgb;
    flags = pal(o, 1);
    // Under the fill: the terrain with its pattern softened (blend with the terrain blurred over ~8 tiles, mip level 3,
    // so changes between terrains shade the nation gently instead of cutting it into bands) and pulled towards grey,
    // so forest / hills / desert still show as light and dark without competing with the nation's hue.
#if MAP_STYLE == 0
    vec3 under = textureLod(uTerrCol, uv, 3.0).rgb;
    vec3 calm = mix(under, col, ${UNDER_DETAIL.toFixed(3)});
    float cy = dot(calm, vec3(0.299, 0.587, 0.114));
    calm = vec3(${UNDER_MID.toFixed(3)} + (cy - ${UNDER_MID.toFixed(3)}) * ${UNDER_LUM.toFixed(3)}) + (calm - cy) * ${UNDER_CHROMA.toFixed(3)};
    vec3 fill = mix(calm, oc, pc.a);
#else
    // a colour tint: the nation's hue at the ground's own brightness (pulled kL of the way to the nation colour's), so
    // fields, trees and hill shading read through it; pc.a = how much of that covers the ground
    // The nation colour over the ground, plus the ground's own light and dark: its small detail (trees, fields, faces)
    // in full, its broad brightness (snow against forest) only in part, so the nation reads as one colour at a glance.
    float gy = dot(col, vec3(0.299, 0.587, 0.114));
    float avgY = dot(textureLod(uGroundCol, uv, 2.5).rgb, vec3(0.299, 0.587, 0.114));
#if MAP_STYLE == 1
    vec2 kD = vec2(0.95, 0.3);
#elif MAP_STYLE == 2
    vec2 kD = vec2(0.45, 0.2);
#else
    vec2 kD = vec2(1.0, 1.0);
#endif
#if MAP_STYLE == 3
    // real ground: the nation's hue at the ground's brightness (palette.ts groundTint), light close in where the border
    // bands carry the nation, stronger far out where the bands get too thin; tribes lighter still
    bool tribeHere = int(flags.r * 255.0 + 0.5) == 3;
    float avgK = mix(gy, avgY, nearG);
    vec4 tk = tribeHere ? TINT_TRIBE : mix(TINT_FAR, TINT_NEAR, smoothstep(${GROUND_TINT_ZOOM[0].toFixed(2)}, ${GROUND_TINT_ZOOM[1].toFixed(2)}, zc));
    vec3 fill = tintGround(col, gy, avgK, oc, tk);
    // the border band: a thick strip of the nation's colour just inside its border, in whole art pixels (about 10 CSS px,
    // a little less close in), the ground still showing through it; drawn here, under forts, trenches, flashes and
    // fallout, so they all still show on it. The dark border line goes on top later.
    if (P >= 2.0 && !tribeHere) {
      float a1 = 1.0 / P;
      float bandCss = mix(10.0, 7.0, smoothstep(12.0, 32.0, zc));
      float bandW = min(max(floor(bandCss / zc * P + 0.5) / P, 3.0 * a1), 1.0);
      float dB = edgeDist(ti, fq, o, fogHere, bandW);
      if (dB < bandW) {
        vec3 band = tintGround(col, gy, avgK, oc, TINT_BAND);
        // a one-pixel step between band and fill, so the band's inner edge is crisp but not a hard cut
        fill = dB >= bandW - a1 ? mix(fill, band, 0.5) : band;
      }
    }
#else
    float fa = pc.a;
    vec3 fill = mix(col, oc, fa) + fa * ((gy - avgY) * kD.x + (avgY - 0.45) * kD.y) * nearG;
#endif
#endif
#if MAP_STYLE != 3
    // tribes: a light tint straight over the terrain (no grey wash), so the far map stays land, not grey patches
    if (int(flags.r * 255.0 + 0.5) == 3) fill = mix(col, oc, pc.a);
#endif
    if (res > 0 && detail > 0.0) {
      // under a nation deposits only shade the colour faintly (no foreign hues, no dotted clusters), and only very
      // close: the deposit markers already say where the fields are
      vec4 dep = depositAt(res, ti, f, px);
      fill *= 1.0 + dep.a * smoothstep(10.0, 16.0, uZoom) * (res == 3 ? 0.03 : -0.08);
    }
    col = fill;
    // fort coverage: light diagonal hatch on the protected tiles
    if (uFortOn == 1 && uZoom >= 2.0 && live) {
      uint fo = texelFetch(uFort, ti, 0).r;
      if (fo == o) {
        float period = max(1.4, 9.0 * px);
        float s = fract((t.x + t.y) / period);
        float hatch = 1.0 - smoothstep(0.14, 0.14 + 1.5 * px / period, abs(s - 0.5) * 2.0 - 0.72);
        col = mix(col, int(flags.r * 255.0 + 0.5) == 1 ? vec3(1.0) : oc * 0.55, hatch * 0.2);
      }
    }
    // trenches (dug-in borders): a faint earth hatch on dug tiles, a zig-zag line along each edge facing a nation
    if (uTrenchOn == 1 && uZoom >= 2.5 && live) {
      int lvl = trenchAt(ti);
      if (lvl > 0) {
        vec3 earth = vec3(0.2, 0.13, 0.07);
        float period = max(0.6, 6.0 * px);
        float s = fract((t.x - t.y) / period);
        float hatch = 1.0 - smoothstep(0.1, 0.1 + 1.5 * px / period, abs(s - 0.5) * 2.0 - 0.8);
        col = mix(col, earth, hatch * (0.06 + 0.03 * float(min(lvl, 3))) * smoothstep(2.5, 4.0, uZoom));
        float zz = smoothstep(3.0, 5.0, uZoom);
        if (zz > 0.0) {
          float sAlong;
          float d = foeEdge(ti, f, t, o, sAlong);
          if (d < 1.0) col = mix(col, earth, trenchMark(d, sAlong, lvl, px) * 0.88 * zz);
        }
      }
    }
  }

  // ---- fallout
  if ((raw & 0x1000u) != 0u && live) {
    float stripe = step(0.5, fract((t.x - t.y) * 0.5));
    col = mix(col, vec3(0.5, 0.58, 0.36), 0.55 + 0.1 * stripe * detail);
  }

  // ---- capture flash (fronts): yours yellow, losses red, others a light glow
  uint kind = (raw >> 13u) & 7u;
  if (kind != 0u && live) {
    float age = float((uNowDs - (raw >> 16u)) & 0xFFFFu) * 0.1;
    float a = clamp(1.0 - age / 1.6, 0.0, 1.0);
    a = a * a;
    vec3 fc = kind == 1u ? vec3(1.0, 0.9, 0.42) : kind == 2u ? vec3(1.0, 0.24, 0.18) : vec3(1.0);
    col = mix(col, fc, a * (kind == 3u ? 0.3 : 0.55));
  }

  // ---- borders: where a 4-neighbour (or a diagonal, for corners) has a different owner
  if (o != 0u) {
    bool edge = false;
    float bpx = clamp(uZoom * 0.13, 1.3, 3.2); // border width in device px
#if MAP_STYLE != 0
    if (P >= 2.0) {
      // crisp pixel borders, in whole art pixels: a dark line (two pixels for a hovered nation or a deep trench), then
      // a one-pixel light inner edge (pixel terrain, muted map) or a thick band of the nation colour (real ground)
      int relB = int(flags.r * 255.0 + 0.5);
      float a1 = 1.0 / P;
      float hb = flags.b > 0.0 ? 2.0 : 1.0;
      if (uTrenchOn == 1 && live && zc < 5.0 && trenchAt(ti) >= 2) hb = 2.0;
      float lineW = a1 * hb;
#if MAP_STYLE == 3
      // real ground: the band is already drawn (with the fill), only the line here
      float bandW = lineW;
#else
      float bandW = relB == 3 ? lineW : lineW + a1;
#endif
      float dE = edgeDist(ti, fq, o, fogHere, bandW);
      if (dE < lineW) edge = true;
      else if (dE < bandW) col = mix(col, vec3(1.0), relB == 1 ? 0.3 : 0.2);
    } else
#endif
    if (uZoom < 1.0) {
      int s = int(ceil(1.0 / uZoom));
      edge = borderTo(ti, ti + ivec2(s, 0), o, fogHere) || borderTo(ti, ti - ivec2(s, 0), o, fogHere) || borderTo(ti, ti + ivec2(0, s), o, fogHere) || borderTo(ti, ti - ivec2(0, s), o, fogHere);
    } else {
      float bw = min(1.0, bpx * px);
      float hb = flags.b > 0.0 ? 1.6 : 1.0;
      // far out a level 2+ trench shows as a thicker, earth-dark border (the line itself needs ~4 px a tile)
      if (uTrenchOn == 1 && live && uZoom < 5.0 && trenchAt(ti) >= 2) hb = max(hb, 1.0 + 0.9 * (1.0 - smoothstep(3.0, 5.0, uZoom)));
      bw = min(1.0, bw * hb);
      bool l = f.x < bw, r = f.x > 1.0 - bw, u = f.y < bw, d = f.y > 1.0 - bw;
      if (l && borderTo(ti, ti + ivec2(-1, 0), o, fogHere)) edge = true;
      else if (r && borderTo(ti, ti + ivec2(1, 0), o, fogHere)) edge = true;
      else if (u && borderTo(ti, ti + ivec2(0, -1), o, fogHere)) edge = true;
      else if (d && borderTo(ti, ti + ivec2(0, 1), o, fogHere)) edge = true;
      else if (l && u && borderTo(ti, ti + ivec2(-1, -1), o, fogHere)) edge = true;
      else if (r && u && borderTo(ti, ti + ivec2(1, -1), o, fogHere)) edge = true;
      else if (l && d && borderTo(ti, ti + ivec2(-1, 1), o, fogHere)) edge = true;
      else if (r && d && borderTo(ti, ti + ivec2(1, 1), o, fogHere)) edge = true;
    }
    if (edge) {
      vec3 oc = pal(o, 0).rgb;
      int rel = int(flags.r * 255.0 + 0.5);
      vec3 bc = pal(o, 2).rgb; // darker, slightly more saturated shade of the nation colour (palette.ts)
      float ba = 1.0;
      if (rel == 3) bc = mix(col, vec3(0.95), 0.22); // tribe parcels: a faint light edge, not a dark outline
      else if (rel == 1) bc = vec3(0.97);
      else if (rel == 2) {
        bc = mix(oc, vec3(1.0), 0.6);
        float period = max(1.5, 12.0 * px);
        if (fract((t.x + t.y) / period) > 0.6) bc = oc * 0.6;
      }
      // far out the trench line can't be drawn: a level 2+ trench darkens the border to earth instead
      if (uTrenchOn == 1 && live && uZoom < 5.0) {
        int tl = trenchAt(ti);
        if (tl >= 2) bc = mix(bc, vec3(0.2, 0.13, 0.07), (0.5 + 0.1 * float(tl - 2)) * (1.0 - smoothstep(3.0, 5.0, uZoom)));
      }
      if (flags.g > 0.5) bc = mix(bc, vec3(0.95, 0.2, 0.15), 0.7);
      int hv = int(flags.b * 255.0 + 0.5);
      if (hv == 1) bc = mix(bc, vec3(1.0), 0.65);
      else if (hv == 2) bc = mix(bc, vec3(1.0, 0.22, 0.16), 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 6.0)));
      col = mix(col, bc, ba);
    }
  }

  // ---- fog of war: explored land greyed and darker (what you saw last), unexplored dark terrain only
  if (uFogOn == 1) {
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 mem = mix(vec3(g), col, ${FOG.exploredSaturation.toFixed(3)}) * ${FOG.exploredShade.toFixed(3)};
    vec3 dark = mix(uBg, vec3(g) * ${FOG.unexploredShade.toFixed(3)}, 0.6);
    col = mix(dark, mix(mem, col, fogLive), fogSeen);
  }

  // ---- overlays
  if (uAuxMode == 1) {
    float v = texelFetch(uAux, ti, 0).r * 255.0;
    if (v > 0.5) {
      float rr = (v - 1.0) / 84.0; // in units of the supply range
      vec3 sc = rr <= 1.0 ? vec3(0.24, 0.82, 0.35) : rr <= 3.0 ? mix(vec3(0.92, 0.84, 0.24), vec3(0.92, 0.5, 0.16), (rr - 1.0) / 2.0) : vec3(0.88, 0.18, 0.16);
      col = mix(col, sc, rr <= 1.0 ? 0.3 : 0.42);
    }
  } else if (uAuxMode == 2) {
    float v = texelFetch(uAux, ti, 0).r * 255.0;
    if (v > 1.5) col = mix(col, vec3(0.8, 0.16, 0.16), 0.3);
    else if (o == 0u && !water && (raw & 0x1000u) == 0u) col = mix(col, vec3(1.0), 0.08);
  }
  if (uShowRes == 1) {
    if (res > 0 && fogSeen > 0.5) {
      float ring = 1.0;
      col = mix(col * 0.5, uRes[res], 0.85 * ring);
    } else col *= 0.55;
  }

  // faint tile grid when zoomed in a lot
  if (uZoom >= 22.0) {
    float g = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    col *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, px * 1.2, g)) * smoothstep(22.0, 34.0, uZoom);
  }
  outColor = vec4(col, 1.0);
}
#endif
`;

export const MAP_FS = mapFragmentShader('today');
