// WebGL2 map layer: terrain, nations, borders, capture flashes, fort coverage, fallout and overlays in one
// fullscreen fragment pass (shaders.ts). Textures are uploaded once per game except:
//   owner   dirty 64 x 64 blocks from the tile feed, merged into row runs (texSubImage2D with UNPACK_ROW_LENGTH,
//           straight from the mirror array: no copies); a full upload on overflow or a new game
//   palette 1024 x 12 RGBA (display colour + opacity, flags, border colour), re-sent when relations, hover or players change (a few KB)
//   fort    rectangles around forts that were added or removed
//   aux     supply classes (own territory box, about once a second) or the spawn mask (spawn phase)
//   trench  trench level per tile (R8, 0..4), dirty blocks from the trench feed (trenchFeed.ts)
//   fog     fog of war, one texel per 16 x 16 tile block (R8: 255 in view, 110 explored, 0 never seen; LINEAR, so the
//           shader gets soft edges), re-sent only when the view changes (fog/fogView.ts)
//   ground  the pixel map styles' height, hill shading and far colours (render/ground.ts), built and sent once per game
//           the first time such a style is on (today's look never builds them)
// The fragment shader is built for the map style (render/mapStyle.ts); setStyle relinks it when the style changes.
import type { MapData } from '../../sim/types';
import type { RGB } from './common';
import { buildGround } from './ground';
import { mapStyle, type MapStyle } from './mapStyle';
import { borderColor, displayColor, fillAlpha, type DisplayRole, type Rgb } from './palette';
import { groundFragmentShader, mapFragmentShader, MAP_VS } from './shaders';
import { TERRAIN_RGB, RESOURCE_RGB, type TerrainData } from './terrain';
import { dirtyRects, type TileFeed } from './tiles';
import type { TrenchFeed } from './trenchFeed';

export const PALETTE_W = 1024;
export const PALETTE_H = 12;
const MAX_OWNERS = PALETTE_W * 4;
const BG: RGB = [10, 17, 28];

export interface MapUniforms {
  centerX: number;
  centerY: number;
  /** device px per tile */
  zoom: number;
  timeS: number;
  nowDs: number;
  auxMode: 0 | 1 | 2;
  showRes: boolean;
  fortOn: boolean;
  /** any tile dug: draw trench lines */
  trenchOn: boolean;
  /** fog of war is drawn (the fog texture holds this client's view) */
  fogOn?: boolean;
  /** device px per CSS px (the pixel styles size their art pixels in CSS px) */
  dpr?: number;
}

const UNIFORMS = ['uOwner', 'uTerrId', 'uDepth', 'uTerrCol', 'uPal', 'uFort', 'uAux', 'uTrench', 'uView', 'uCenter', 'uZoom', 'uMap', 'uTime', 'uNowDs', 'uAuxMode', 'uShowRes', 'uFortOn', 'uTrenchOn', 'uTerr', 'uRes', 'uBg', 'uFog', 'uFogOn', 'uFogScale', 'uGround', 'uGroundCol', 'uGroundTex', 'uGOrigin', 'uP', 'uDpr'];
type TexName = 'owner' | 'terrId' | 'depth' | 'terrCol' | 'pal' | 'fort' | 'aux' | 'trench' | 'fog' | 'ground' | 'groundCol' | 'groundView';
/** Texture units, in order (the sampler uniform of each is set to its index). */
const TEX_ORDER: readonly TexName[] = ['owner', 'terrId', 'depth', 'terrCol', 'pal', 'fort', 'aux', 'trench', 'fog', 'ground', 'groundCol', 'groundView'];
const SAMPLERS = ['uOwner', 'uTerrId', 'uDepth', 'uTerrCol', 'uPal', 'uFort', 'uAux', 'uTrench', 'uFog', 'uGround', 'uGroundCol', 'uGroundTex'];
/** Art pixels are at least this many CSS px wide (shaders.ts: P art pixels per tile, a power of two up to 16). */
const ART_PX_MIN = 1.25;
/** The ground pass is redrawn at most this often while the view stands still (its waves and foam move slowly). */
const GROUND_FRAME_MS = 200;

/** Art pixels per tile of the pixel map styles at a zoom (CSS px per tile): a power of two, 1 to 16. */
export function artPixelsPerTile(zoomCss: number): number {
  const k = Math.floor(Math.log2(Math.max(1e-6, zoomCss) / ART_PX_MIN));
  return 2 ** Math.max(0, Math.min(4, k));
}
interface Prog {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

export class MapGL {
  readonly gl: WebGL2RenderingContext;
  lost = false;
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  /** the pixel styles' ground pass (null for today's look): one fragment per art pixel into groundView */
  private ground: Prog | null = null;
  private fbo: WebGLFramebuffer | null = null;
  /** groundView's allocated size and what it holds now (redrawn only when this changes) */
  private gvW = 0;
  private gvH = 0;
  private gvKey = '';
  private tex: Record<TexName, WebGLTexture>;
  /** the map style the shader is built for */
  style: MapStyle;
  /** this game's map and terrain (the ground textures are built from them when a pixel style first shows) */
  private game: { map: MapData; terr: TerrainData } | null = null;
  private groundBuilt = false;
  /** fog texture size in blocks (0 = none uploaded) */
  private fogW = 0;
  private fogH = 0;
  private vao: WebGLVertexArrayObject;
  /** display + border colours by (rgb, role): the same few colours come back on every palette re-send */
  private shown = new Map<number, { fill: Rgb; border: Rgb }>();
  private w = 0;
  private h = 0;
  /** palette data: rows 0-3 display colours (alpha = fill opacity), rows 4-7 flags, rows 8-11 border colours */
  readonly palette = new Uint8Array(PALETTE_W * PALETTE_H * 4);
  /** uploads this frame (stats) */
  uploads = 0;
  /** tiles uploaded this frame (stats) */
  uploadTiles = 0;

  static create(canvas: HTMLCanvasElement): MapGL | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new MapGL(gl, canvas);
    } catch (err) {
      console.warn('WebGL2 map layer unavailable, using Canvas2D', err);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.gl = gl;
    this.style = mapStyle();
    const mk = (): WebGLTexture => {
      const t = gl.createTexture();
      if (!t) throw new Error('createTexture failed');
      return t;
    };
    this.tex = { owner: mk(), terrId: mk(), depth: mk(), terrCol: mk(), pal: mk(), fort: mk(), aux: mk(), trench: mk(), fog: mk(), ground: mk(), groundCol: mk(), groundView: mk() };
    try {
      this.prog = this.usePrograms(this.style);
    } catch (err) {
      if (this.style === 'today') throw err;
      console.warn('map style unavailable', this.style, err);
      this.style = 'today';
      this.prog = this.usePrograms('today');
    }
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  /** Links a fragment shader and sets its fixed uniforms. */
  private makeProgram(fs: string): Prog {
    const gl = this.gl;
    const prog = link(gl, MAP_VS, fs);
    gl.useProgram(prog);
    const loc: Prog['loc'] = {};
    for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(prog, name);
    SAMPLERS.forEach((u, k) => gl.uniform1i(loc[u], k));
    gl.uniform3fv(loc.uTerr, new Float32Array(TERRAIN_RGB.flatMap((c) => c.map((v) => v / 255))));
    gl.uniform3fv(loc.uRes, new Float32Array(RESOURCE_RGB.flatMap((c) => c.map((v) => v / 255))));
    gl.uniform3f(loc.uBg, BG[0] / 255, BG[1] / 255, BG[2] / 255);
    if (this.w > 0) gl.uniform2f(loc.uMap, this.w, this.h);
    return { prog, loc };
  }

  /** Links the map shader of a style (and its ground pass) and makes them current; returns the map program. */
  private usePrograms(style: MapStyle): WebGLProgram {
    const main = this.makeProgram(mapFragmentShader(style));
    let ground: Prog | null = null;
    if (style !== 'today') {
      try {
        ground = this.makeProgram(groundFragmentShader(style));
      } catch (err) {
        this.gl.deleteProgram(main.prog);
        throw err;
      }
    }
    if (this.ground) this.gl.deleteProgram(this.ground.prog);
    this.ground = ground;
    this.gvKey = '';
    this.loc = main.loc;
    return main.prog;
  }

  /**
   * Switches the map style: relinks the shader, sets the per-game uniforms again and builds the ground textures if
   * the new style needs them. The palette must be written again (setPalette) since fill strength depends on the style.
   */
  setStyle(style: MapStyle): void {
    if (style === this.style) return;
    const gl = this.gl;
    const old = this.prog;
    try {
      this.prog = this.usePrograms(style);
    } catch (err) {
      // a driver that refuses the new shader keeps the one it has (and is not asked again for this style)
      console.warn('map style unavailable', style, err);
      this.style = style;
      return;
    }
    gl.deleteProgram(old);
    this.style = style;
    this.shown.clear();
    gl.useProgram(this.prog);
    if (this.fogW > 0) gl.uniform2f(this.loc.uFogScale, 1 / (this.fogW * 16), 1 / (this.fogH * 16));
    this.ensureGround();
  }

  /** Builds and sends the ground textures once per game, when a pixel style is on. */
  private ensureGround(): void {
    if (this.style === 'today' || this.groundBuilt || !this.game) return;
    const gl = this.gl;
    const { map, terr } = this.game;
    const g = buildGround(map, terr.depth);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    resetUnpack(gl);
    this.bind(9, this.tex.ground, gl.LINEAR, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, map.width, map.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, g.data);
    this.bind(10, this.tex.groundCol, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, map.width, map.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, g.far);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.groundBuilt = true;
    this.gvKey = '';
  }

  /** Max texture side the GPU supports. */
  get maxSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  /** Uploads the per-game textures. */
  setGame(map: MapData, terr: TerrainData, mirror: Uint32Array): void {
    const gl = this.gl;
    const w = map.width;
    const h = map.height;
    this.w = w;
    this.h = h;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    resetUnpack(gl);
    // terrain id + resource
    const tr = new Uint8Array(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      tr[i * 2] = map.terrain[i];
      tr[i * 2 + 1] = map.resource[i];
    }
    this.bind(1, this.tex.terrId, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, tr);
    // depth (x10, linear)
    const dep = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) dep[i] = Math.min(255, terr.depth[i] * 10);
    this.bind(2, this.tex.depth, gl.LINEAR, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, dep);
    // flat colours, mipmapped
    this.bind(3, this.tex.terrCol, gl.LINEAR_MIPMAP_LINEAR, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(terr.rgba.buffer, terr.rgba.byteOffset, terr.rgba.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
    // owner
    this.bind(0, this.tex.owner, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, mirror);
    // palette
    this.bind(4, this.tex.pal, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_W, PALETTE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.palette);
    // fort owners
    this.bind(5, this.tex.fort, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(w * h));
    // aux
    this.bind(6, this.tex.aux, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(w * h));
    // trench levels
    this.bind(7, this.tex.trench, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(w * h));
    // fog of war (a 1 x 1 placeholder until a fog view uploads its grid)
    this.bind(8, this.tex.fog, gl.LINEAR, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    this.fogW = 0;
    this.fogH = 0;
    // ground textures: 1 x 1 placeholders until a pixel style needs them
    this.bind(9, this.tex.ground, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 0, 128, 0]));
    this.bind(10, this.tex.groundCol, gl.NEAREST, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([90, 110, 80, 255]));
    this.game = { map, terr };
    this.groundBuilt = false;
    this.gvKey = '';
    this.ensureGround();
    if (this.ground) {
      gl.useProgram(this.ground.prog);
      gl.uniform2f(this.ground.loc.uMap, w, h);
    }
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.uMap, w, h);
  }

  /** Uploads the fog grid (bw x bh blocks of 16 tiles; values as fog/fogView.ts tex). */
  uploadFog(tex: Uint8Array, bw: number, bh: number): void {
    if (bw <= 0 || bh <= 0 || tex.length < bw * bh) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fog);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    resetUnpack(gl);
    if (bw !== this.fogW || bh !== this.fogH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bw, bh, 0, gl.RED, gl.UNSIGNED_BYTE, tex);
      this.fogW = bw;
      this.fogH = bh;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RED, gl.UNSIGNED_BYTE, tex);
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.uFogScale, 1 / (bw * 16), 1 / (bh * 16));
    this.uploads++;
  }

  /** Uploads the dirty blocks of the owner mirror. */
  uploadOwner(feed: TileFeed): void {
    const gl = this.gl;
    this.uploads = 0;
    this.uploadTiles = 0;
    if (feed.dirtyList.length === 0) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.owner);
    const rects = dirtyRects(feed, 2);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.w);
    for (const [x, y, rw, rh] of rects) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED_INTEGER, gl.UNSIGNED_INT, feed.mirror);
      this.uploads++;
      this.uploadTiles += rw * rh;
    }
    resetUnpack(gl);
  }

  /** Uploads the dirty blocks of the trench levels. */
  uploadTrench(feed: TrenchFeed): void {
    if (feed.dirtyList.length === 0 || feed.w !== this.w || feed.h !== this.h) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.trench);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.w);
    for (const [x, y, rw, rh] of dirtyRects(feed, 2)) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED, gl.UNSIGNED_BYTE, feed.level);
      this.uploads++;
      this.uploadTiles += rw * rh;
    }
    resetUnpack(gl);
  }

  uploadPalette(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.pal);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PALETTE_W, PALETTE_H, gl.RGBA, gl.UNSIGNED_BYTE, this.palette);
  }

  /** Uploads a rectangle of a full-map array (Uint16 fort owners or Uint8 aux values). */
  uploadRect(which: 'fort' | 'aux', data: Uint16Array | Uint8Array, x: number, y: number, rw: number, rh: number): void {
    if (rw <= 0 || rh <= 0) return;
    const gl = this.gl;
    gl.activeTexture(which === 'fort' ? gl.TEXTURE5 : gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[which]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.w);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    if (which === 'fort') gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED, gl.UNSIGNED_BYTE, data);
    resetUnpack(gl);
  }

  /**
   * The pixel styles' ground for this view, one texel per art pixel (P per tile), into groundView. Redrawn only when
   * the view's art pixel grid moves or GROUND_FRAME_MS passes (the waves); far out (below 2 CSS px a tile) the map
   * shows the far colours only and nothing is drawn. Returns the origin (art pixel coords of texel 0, 0).
   */
  private drawGround(viewW: number, viewH: number, u: MapUniforms, P: number): [number, number] {
    const gl = this.gl;
    const g = this.ground!;
    const ox = Math.floor((u.centerX - viewW / 2 / u.zoom) * P) - 2;
    const oy = Math.floor((u.centerY - viewH / 2 / u.zoom) * P) - 2;
    const gw = Math.ceil((viewW / u.zoom) * P) + 5;
    const gh = Math.ceil((viewH / u.zoom) * P) + 5;
    const key = `${P}:${ox}:${oy}:${gw}:${gh}:${Math.floor((u.timeS * 1000) / GROUND_FRAME_MS)}`;
    if (key === this.gvKey) return [ox, oy];
    this.gvKey = key;
    if (!this.fbo) this.fbo = gl.createFramebuffer();
    if (gw > this.gvW || gh > this.gvH) {
      this.gvW = Math.max(gw, this.gvW);
      this.gvH = Math.max(gh, this.gvH);
      this.bind(11, this.tex.groundView, gl.NEAREST, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.gvW, this.gvH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // the target is not bound to a texture unit while drawn into
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.groundView, 0);
    gl.viewport(0, 0, gw, gh);
    gl.useProgram(g.prog);
    gl.uniform1f(g.loc.uTime, u.timeS);
    gl.uniform2i(g.loc.uGOrigin, ox, oy);
    gl.uniform1f(g.loc.uP, P);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [ox, oy];
  }

  draw(viewW: number, viewH: number, u: MapUniforms): void {
    const gl = this.gl;
    const dpr = u.dpr ?? 1;
    const P = artPixelsPerTile(u.zoom / dpr);
    TEX_ORDER.forEach((k, unit) => {
      if (k === 'groundView') return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
    });
    let origin: [number, number] = [0, 0];
    if (this.ground && this.groundBuilt && u.zoom / dpr > 2) origin = this.drawGround(viewW, viewH, u, P);
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.groundView);
    gl.viewport(0, 0, viewW, viewH);
    gl.useProgram(this.prog);
    TEX_ORDER.forEach((k, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
    });
    const L = this.loc;
    gl.uniform2f(L.uView, viewW, viewH);
    gl.uniform2f(L.uCenter, u.centerX, u.centerY);
    gl.uniform1f(L.uZoom, u.zoom);
    gl.uniform1f(L.uTime, u.timeS);
    gl.uniform1ui(L.uNowDs, u.nowDs & 0xffff);
    gl.uniform1i(L.uAuxMode, u.auxMode);
    gl.uniform1i(L.uShowRes, u.showRes ? 1 : 0);
    gl.uniform1i(L.uFortOn, u.fortOn ? 1 : 0);
    gl.uniform1i(L.uTrenchOn, u.trenchOn ? 1 : 0);
    gl.uniform1i(L.uFogOn, u.fogOn && this.fogW > 0 ? 1 : 0);
    gl.uniform1f(L.uDpr, dpr);
    gl.uniform1f(L.uP, P);
    gl.uniform2i(L.uGOrigin, origin[0], origin[1]);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Writes one owner's palette entry: relation 0 other / 1 you / 2 ally / 3 tribe, traitor, hover. `c` is the
   * nation's colour as the rest of the game uses it; the map paints the calmer palette.ts version of it.
   */
  setPalette(id: number, c: readonly number[], relation: number, traitor: boolean, hover: number): void {
    if (id < 0 || id >= MAX_OWNERS) return;
    const role: DisplayRole = relation === 1 ? 'own' : relation === 3 ? 'tribe' : 'nation';
    const key = ((c[0] << 16) | (c[1] << 8) | c[2]) * 4 + (relation === 1 ? 1 : relation === 3 ? 2 : 0);
    let d = this.shown.get(key);
    if (!d) {
      const fill = displayColor(c, { role, style: this.style });
      d = { fill, border: borderColor(fill) };
      if (this.shown.size > 4096) this.shown.clear();
      this.shown.set(key, d);
    }
    const p = this.palette;
    const x = id & 1023;
    const row = id >> 10;
    const ci = (row * PALETTE_W + x) * 4;
    p[ci] = d.fill[0];
    p[ci + 1] = d.fill[1];
    p[ci + 2] = d.fill[2];
    p[ci + 3] = Math.round(fillAlpha(this.style, relation === 3) * 255);
    const fi = ((row + 4) * PALETTE_W + x) * 4;
    p[fi] = relation;
    p[fi + 1] = traitor ? 255 : 0;
    p[fi + 2] = hover;
    p[fi + 3] = 0;
    const bi = ((row + 8) * PALETTE_W + x) * 4;
    p[bi] = d.border[0];
    p[bi + 1] = d.border[1];
    p[bi + 2] = d.border[2];
    p[bi + 3] = 255;
  }

  private bind(unit: number, t: WebGLTexture, min: number, mag: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}

function resetUnpack(gl: WebGL2RenderingContext): void {
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader compile failed: ' + log);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
  return p;
}
