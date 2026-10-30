// WebGL2 map layer: terrain, nations, borders, capture flashes, fort coverage, fallout and overlays in one
// fullscreen fragment pass (shaders.ts). Textures are uploaded once per game except:
//   owner   dirty 64 x 64 blocks from the tile feed, merged into row runs (texSubImage2D with UNPACK_ROW_LENGTH,
//           straight from the mirror array: no copies); a full upload on overflow or a new game
//   palette 1024 x 8 RGBA, re-sent when relations, hover or players change (a few KB)
//   fort    rectangles around forts that were added or removed
//   aux     supply classes (own territory box, about once a second) or the spawn mask (spawn phase)
import type { MapData } from '../../sim/types';
import type { RGB } from './common';
import { MAP_FS, MAP_VS } from './shaders';
import { TERRAIN_RGB, RESOURCE_RGB, type TerrainData } from './terrain';
import { dirtyRects, type TileFeed } from './tiles';

export const PALETTE_W = 1024;
export const PALETTE_H = 8;
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
}

export class MapGL {
  readonly gl: WebGL2RenderingContext;
  lost = false;
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private tex: Record<'owner' | 'terrId' | 'depth' | 'terrCol' | 'pal' | 'fort' | 'aux', WebGLTexture>;
  private vao: WebGLVertexArrayObject;
  private w = 0;
  private h = 0;
  /** palette data: rows 0-3 colours, rows 4-7 flags */
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
    this.prog = link(gl, MAP_VS, MAP_FS);
    gl.useProgram(this.prog);
    for (const name of ['uOwner', 'uTerrId', 'uDepth', 'uTerrCol', 'uPal', 'uFort', 'uAux', 'uView', 'uCenter', 'uZoom', 'uMap', 'uTime', 'uNowDs', 'uAuxMode', 'uShowRes', 'uFortOn', 'uTerr', 'uRes', 'uBg']) {
      this.loc[name] = gl.getUniformLocation(this.prog, name);
    }
    const units = ['uOwner', 'uTerrId', 'uDepth', 'uTerrCol', 'uPal', 'uFort', 'uAux'];
    units.forEach((u, k) => gl.uniform1i(this.loc[u], k));
    gl.uniform3fv(this.loc.uTerr, new Float32Array(TERRAIN_RGB.flatMap((c) => c.map((v) => v / 255))));
    gl.uniform3fv(this.loc.uRes, new Float32Array(RESOURCE_RGB.flatMap((c) => c.map((v) => v / 255))));
    gl.uniform3f(this.loc.uBg, BG[0] / 255, BG[1] / 255, BG[2] / 255);
    const mk = (): WebGLTexture => {
      const t = gl.createTexture();
      if (!t) throw new Error('createTexture failed');
      return t;
    };
    this.tex = { owner: mk(), terrId: mk(), depth: mk(), terrCol: mk(), pal: mk(), fort: mk(), aux: mk() };
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
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
    gl.uniform2f(this.loc.uMap, w, h);
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

  draw(viewW: number, viewH: number, u: MapUniforms): void {
    const gl = this.gl;
    gl.viewport(0, 0, viewW, viewH);
    gl.useProgram(this.prog);
    const order: (keyof MapGL['tex'])[] = ['owner', 'terrId', 'depth', 'terrCol', 'pal', 'fort', 'aux'];
    order.forEach((k, unit) => {
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
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Writes one owner's palette entry: colour and flags (relation 0 other / 1 you / 2 ally / 3 tribe, traitor, hover). */
  setPalette(id: number, c: readonly number[], relation: number, traitor: boolean, hover: number): void {
    if (id < 0 || id >= MAX_OWNERS) return;
    const p = this.palette;
    const x = id & 1023;
    const row = id >> 10;
    const ci = (row * PALETTE_W + x) * 4;
    p[ci] = c[0];
    p[ci + 1] = c[1];
    p[ci + 2] = c[2];
    p[ci + 3] = 255;
    const fi = ((row + 4) * PALETTE_W + x) * 4;
    p[fi] = relation;
    p[fi + 1] = traitor ? 255 : 0;
    p[fi + 2] = hover;
    p[fi + 3] = 0;
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
