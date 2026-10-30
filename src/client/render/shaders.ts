// GLSL for the map layer (WebGL2). One fullscreen pass: terrain, nations, borders, overlays.
import { UNDER_CHROMA, UNDER_DETAIL } from './palette';

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
 */
export const MAP_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D uOwner;
uniform sampler2D uTerrId;
uniform sampler2D uDepth;
uniform sampler2D uTerrCol;
uniform sampler2D uPal;
uniform usampler2D uFort;
uniform sampler2D uAux;

uniform vec2 uView;
uniform vec2 uCenter;
uniform float uZoom;
uniform vec2 uMap;
uniform float uTime;
uniform uint uNowDs;
uniform int uAuxMode;
uniform int uShowRes;
uniform int uFortOn;
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
vec4 pal(uint o, int row) {
  return texelFetch(uPal, ivec2(int(o & 1023u), int(o >> 10u) + row * 4), 0);
}
float hash(ivec2 c, uint salt) {
  uint x = uint(c.x) * 1664525u ^ (uint(c.y) * 1013904223u) ^ (salt * 2654435761u);
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return float(x) * (1.0 / 4294967296.0);
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

  // ---- terrain
  float lum = 0.0;
  vec3 col;
  float near = smoothstep(1.2, 2.6, uZoom);
  vec3 flat_ = texture(uTerrCol, uv).rgb;
  if (water) {
    float d = texture(uDepth, uv).r * 25.5; // tiles to land, smooth
    float k = smoothstep(1.0, 11.0, d);
    vec3 wc = mix(uTerr[1], uTerr[0], k);
    wc += vec3(0.05, 0.07, 0.07) * (1.0 - smoothstep(0.55, 1.5, d)); // light shore band
    if (detail > 0.0) {
      // faint wave dashes in open water
      vec2 q = t * vec2(1.0, 2.0) / 3.0;
      ivec2 cell = ivec2(floor(q));
      vec2 l = fract(q) - 0.5;
      float on = step(hash(cell, 97u), 0.18) * k;
      float wave = (1.0 - smoothstep(0.22, 0.22 + px, abs(l.x))) * (1.0 - smoothstep(0.03, 0.03 + px * 0.7, abs(l.y + 0.08 * cos(l.x * 9.0))));
      wc += vec3(0.05, 0.06, 0.07) * wave * on * detail;
    }
    col = mix(flat_, wc, near);
  } else {
    vec3 tc = terrainAt(ter, ti, t, f, px, detail, lum);
    // soft sandy shore on land tiles next to water
    float shore = smoothstep(0.08, 0.45, texture(uDepth, uv).r * 25.5);
    tc = mix(tc, vec3(0.86, 0.8, 0.62), shore * 0.5);
    col = mix(flat_, tc, near);
  }

  // ---- deposits on unowned land (close zoom)
  uint raw = rawAt(ti);
  uint o = raw & 0xFFFu;
  if (res > 0 && detail > 0.0) {
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
    vec3 under = textureLod(uTerrCol, uv, 3.0).rgb;
    vec3 calm = mix(under, col, ${UNDER_DETAIL.toFixed(3)});
    calm = mix(vec3(dot(calm, vec3(0.299, 0.587, 0.114))), calm, ${UNDER_CHROMA.toFixed(3)});
    vec3 fill = mix(calm, oc, pc.a);
    if (res > 0 && detail > 0.0) {
      // under a nation deposits only shade the colour faintly (no foreign hues, no dotted clusters), and only very
      // close: the deposit markers already say where the fields are
      vec4 dep = depositAt(res, ti, f, px);
      fill *= 1.0 + dep.a * smoothstep(10.0, 16.0, uZoom) * (res == 3 ? 0.03 : -0.08);
    }
    col = fill;
    // fort coverage: light diagonal hatch on the protected tiles
    if (uFortOn == 1 && uZoom >= 2.0) {
      uint fo = texelFetch(uFort, ti, 0).r;
      if (fo == o) {
        float period = max(1.4, 9.0 * px);
        float s = fract((t.x + t.y) / period);
        float hatch = 1.0 - smoothstep(0.14, 0.14 + 1.5 * px / period, abs(s - 0.5) * 2.0 - 0.72);
        col = mix(col, int(flags.r * 255.0 + 0.5) == 1 ? vec3(1.0) : oc * 0.55, hatch * 0.2);
      }
    }
  }

  // ---- fallout
  if ((raw & 0x1000u) != 0u) {
    float stripe = step(0.5, fract((t.x - t.y) * 0.5));
    col = mix(col, vec3(0.5, 0.58, 0.36), 0.55 + 0.1 * stripe * detail);
  }

  // ---- capture flash (fronts): yours yellow, losses red, others a light glow
  uint kind = (raw >> 13u) & 7u;
  if (kind != 0u) {
    float age = float((uNowDs - (raw >> 16u)) & 0xFFFFu) * 0.1;
    float a = clamp(1.0 - age / 1.6, 0.0, 1.0);
    a = a * a;
    vec3 fc = kind == 1u ? vec3(1.0, 0.9, 0.42) : kind == 2u ? vec3(1.0, 0.24, 0.18) : vec3(1.0);
    col = mix(col, fc, a * (kind == 3u ? 0.3 : 0.55));
  }

  // ---- borders: where a 4-neighbour (or a diagonal, for corners) has a different owner
  if (o != 0u) {
    bool edge = false;
    float bpx = clamp(uZoom * 0.11, 1.0, 3.2); // border width in device px
    if (uZoom < 1.0) {
      int s = int(ceil(1.0 / uZoom));
      edge = ownerAt(ti + ivec2(s, 0)) != o || ownerAt(ti - ivec2(s, 0)) != o || ownerAt(ti + ivec2(0, s)) != o || ownerAt(ti - ivec2(0, s)) != o;
    } else {
      float bw = min(1.0, bpx * px);
      float hb = flags.b > 0.0 ? 1.6 : 1.0;
      bw = min(1.0, bw * hb);
      bool l = f.x < bw, r = f.x > 1.0 - bw, u = f.y < bw, d = f.y > 1.0 - bw;
      if (l && ownerAt(ti + ivec2(-1, 0)) != o) edge = true;
      else if (r && ownerAt(ti + ivec2(1, 0)) != o) edge = true;
      else if (u && ownerAt(ti + ivec2(0, -1)) != o) edge = true;
      else if (d && ownerAt(ti + ivec2(0, 1)) != o) edge = true;
      else if (l && u && ownerAt(ti + ivec2(-1, -1)) != o) edge = true;
      else if (r && u && ownerAt(ti + ivec2(1, -1)) != o) edge = true;
      else if (l && d && ownerAt(ti + ivec2(-1, 1)) != o) edge = true;
      else if (r && d && ownerAt(ti + ivec2(1, 1)) != o) edge = true;
    }
    if (edge) {
      vec3 oc = pal(o, 0).rgb;
      int rel = int(flags.r * 255.0 + 0.5);
      vec3 bc = pal(o, 2).rgb; // darker, slightly more saturated shade of the nation colour (palette.ts)
      float ba = 1.0;
      if (rel == 1) bc = vec3(0.97);
      else if (rel == 2) {
        bc = mix(oc, vec3(1.0), 0.6);
        float period = max(1.5, 12.0 * px);
        if (fract((t.x + t.y) / period) > 0.6) bc = oc * 0.6;
      }
      if (flags.g > 0.5) bc = mix(bc, vec3(0.95, 0.2, 0.15), 0.7);
      int hv = int(flags.b * 255.0 + 0.5);
      if (hv == 1) bc = mix(bc, vec3(1.0), 0.65);
      else if (hv == 2) bc = mix(bc, vec3(1.0, 0.22, 0.16), 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 6.0)));
      col = mix(col, bc, ba);
    }
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
    if (res > 0) {
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
`;
