import vertSource from './shaders/fractal.vert.glsl?raw';
import fragSource from './shaders/fractal.frag.glsl?raw';
import {
  fromNumber,
  toNumber,
  toDecimalString,
  fromDecimalString,
  frexp,
  computeReferenceOrbit,
} from './HighPrecision';

/** How the per-pixel iteration result is turned into a scalar before the palette. */
export type ColorMode = 'smooth' | 'angle' | 'stripe';

/** Built-in palettes, by index, matching the shader's palette() function. */
export const PALETTE_NAMES = ['spectrum', 'ember', 'ice', 'mono'] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

export interface ColorSettings {
  mode: ColorMode;
  /** Index into PALETTE_NAMES. */
  palette: number;
  /** Gradient frequency — how fast the palette cycles. */
  cycle: number;
  /** Palette phase shift, in turns [0, 1). */
  offset: number;
  /** Stripe density (only used by the 'stripe' mode). */
  stripe: number;
}

const COLOR_MODE_IDS: Record<ColorMode, number> = {
  smooth: 0,
  angle: 1,
  stripe: 2,
};

const DEFAULT_COLOR: ColorSettings = {
  mode: 'smooth',
  palette: 0,
  cycle: 0.15,
  offset: 0.477, // ≈ 3.0 rad — reproduces the original hard-coded look
  stripe: 4,
};

/** A fully restorable view: where you are, how deep, and how it's colored. */
export interface Snapshot {
  re: string;
  im: string;
  scale: number;
  maxIter: number;
  color: ColorSettings;
}

export interface View {
  /** View center in the complex plane: [real, imaginary]. */
  center: [number, number];
  /** Vertical extent of the view, in complex-plane units. Smaller = zoomed in. */
  scale: number;
  /** Maximum escape-time iterations. */
  maxIter: number;
}

/**
 * Display-oriented snapshot for the HUD. Distinct from `View`: coordinates are
 * pre-formatted strings carrying the *full* precision the current zoom needs
 * (View's f64 center is fine for round-tripping, but loses the deep digits).
 */
export interface Readout {
  /** Zoom factor vs. the default view (BASE_SCALE / scale). */
  magnification: number;
  /** Vertical extent of the view in complex units. */
  scale: number;
  /** Current escape-time iteration budget. */
  maxIter: number;
  /** Smoothed interactive frame rate; 0 until a first interval is measured. */
  fps: number;
  /** Center coordinate, formatted to the precision the zoom depth warrants. */
  centerRe: string;
  centerIm: string;
}

const REF_TEX_WIDTH = 1024; // reference orbit is laid out W×H in a float texture
const BASE_SCALE = 2.6; // the default, fully-zoomed-out view height

/**
 * Perturbation-theory fractal renderer.
 *
 * The center is held at arbitrary precision (BigInt fixed-point) and used to
 * compute one reference orbit per view, on the CPU. The GPU then renders every
 * pixel as a small f32 *delta* from that reference (see the fragment shader),
 * which is what lets zoom go far past the ~1e-6 wall of naive f32 rendering.
 *
 * Still framework-agnostic: driven entirely through setView() / pan / zoom /
 * render(). The UI never touches GL or the high-precision math.
 */
export class FractalRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private refTexture: WebGLTexture;

  private uResolution: WebGLUniformLocation | null;
  private uScaleM: WebGLUniformLocation | null;
  private uScaleE: WebGLUniformLocation | null;
  private uMaxIter: WebGLUniformLocation | null;
  private uRefLen: WebGLUniformLocation | null;
  private uRefTexWidth: WebGLUniformLocation | null;
  private uColorMode: WebGLUniformLocation | null;
  private uPalette: WebGLUniformLocation | null;
  private uCycle: WebGLUniformLocation | null;
  private uOffset: WebGLUniformLocation | null;
  private uStripe: WebGLUniformLocation | null;

  // Center is high precision; scale/maxIter are ordinary numbers (f64's range
  // is plenty for scale — the depth limit is the GPU's f32 deltas, not this).
  private center = { re: fromNumber(-0.5), im: fromNumber(0) };
  private scale = BASE_SCALE;
  private maxIter = 512;
  private color: ColorSettings = { ...DEFAULT_COLOR };

  private maxDpr = 2;
  private frameRequested = false;
  // The reference orbit is a pure function of (center, maxIter) — nothing else.
  // Only those two changes set this; scale and color are redraw-only.
  private orbitDirty = true;
  private refLen = 0;

  // Interactive frame-rate estimate, measured from render-to-render intervals.
  private lastFrameTime = 0;
  private fps = 0;

  /** Optional hook fired after each rendered frame, for view read-outs (HUD). */
  onViewChange?: (view: View) => void;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser.');
    }
    this.canvas = canvas;
    this.gl = gl;

    this.program = this.createProgram(vertSource, fragSource);
    gl.useProgram(this.program);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create vertex array object.');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create reference texture.');
    this.refTexture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.uResolution = gl.getUniformLocation(this.program, 'uResolution');
    this.uScaleM = gl.getUniformLocation(this.program, 'uScaleM');
    this.uScaleE = gl.getUniformLocation(this.program, 'uScaleE');
    this.uMaxIter = gl.getUniformLocation(this.program, 'uMaxIter');
    this.uRefLen = gl.getUniformLocation(this.program, 'uRefLen');
    this.uRefTexWidth = gl.getUniformLocation(this.program, 'uRefTexWidth');
    this.uColorMode = gl.getUniformLocation(this.program, 'uColorMode');
    this.uPalette = gl.getUniformLocation(this.program, 'uPalette');
    this.uCycle = gl.getUniformLocation(this.program, 'uCycle');
    this.uOffset = gl.getUniformLocation(this.program, 'uOffset');
    this.uStripe = gl.getUniformLocation(this.program, 'uStripe');

    // The reference orbit lives on texture unit 0.
    const uRefTex = gl.getUniformLocation(this.program, 'uRefTex');
    gl.uniform1i(uRefTex, 0);
    gl.uniform1i(this.uRefTexWidth, REF_TEX_WIDTH);
  }

  getView(): View {
    return {
      center: [toNumber(this.center.re), toNumber(this.center.im)],
      scale: this.scale,
      maxIter: this.maxIter,
    };
  }

  setView(partial: Partial<View>): void {
    if (partial.center) {
      // Absolute set (used for defaults/reset); deep precision is rebuilt by
      // subsequent pan/zoom deltas, which accumulate exactly.
      this.center = {
        re: fromNumber(partial.center[0]),
        im: fromNumber(partial.center[1]),
      };
      this.orbitDirty = true;
    }
    if (partial.scale !== undefined) this.scale = partial.scale; // redraw only
    if (partial.maxIter !== undefined && partial.maxIter !== this.maxIter) {
      this.maxIter = partial.maxIter;
      this.orbitDirty = true;
    }
  }

  /** Set the center from full-precision decimal strings (typed/pasted coords). */
  setCenter(re: string, im: string): void {
    this.center = { re: fromDecimalString(re), im: fromDecimalString(im) };
    this.orbitDirty = true;
  }

  /** Set the view scale directly. The orbit is independent of scale (redraw only). */
  setScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0) this.scale = scale;
  }

  /** Set zoom as a magnification factor vs. the default view. */
  setMagnification(mag: number): void {
    if (Number.isFinite(mag) && mag > 0) this.scale = BASE_SCALE / mag;
  }

  /** Set the escape-time iteration budget. Changes the orbit length. */
  setMaxIter(n: number): void {
    const v = Math.max(1, Math.floor(n));
    if (v !== this.maxIter) {
      this.maxIter = v;
      this.orbitDirty = true;
    }
  }

  getColor(): ColorSettings {
    return { ...this.color };
  }

  /** Update coloring. Never rebuilds the orbit — this is a redraw-only path. */
  setColor(partial: Partial<ColorSettings>): void {
    this.color = { ...this.color, ...partial };
  }

  /** A fully restorable snapshot of the current view (for save / clipboard). */
  getSnapshot(): Snapshot {
    const d = this.coordDecimals();
    return {
      re: toDecimalString(this.center.re, d),
      im: toDecimalString(this.center.im, d),
      scale: this.scale,
      maxIter: this.maxIter,
      color: { ...this.color },
    };
  }

  /** Restore from a (possibly partial, possibly untrusted) snapshot. */
  applySnapshot(s: Partial<Snapshot>): void {
    if (typeof s.re === 'string' && typeof s.im === 'string') {
      this.setCenter(s.re, s.im);
    }
    if (typeof s.scale === 'number') this.setScale(s.scale);
    if (typeof s.maxIter === 'number') this.setMaxIter(s.maxIter);
    if (s.color && typeof s.color === 'object') {
      const c = s.color;
      const next: Partial<ColorSettings> = {};
      if (c.mode === 'smooth' || c.mode === 'angle' || c.mode === 'stripe') {
        next.mode = c.mode;
      }
      if (typeof c.palette === 'number') next.palette = c.palette;
      if (typeof c.cycle === 'number') next.cycle = c.cycle;
      if (typeof c.offset === 'number') next.offset = c.offset;
      if (typeof c.stripe === 'number') next.stripe = c.stripe;
      this.setColor(next);
    }
  }

  /**
   * Display snapshot for the HUD: magnification, scale, iter, fps, and the
   * center formatted to full precision (not the f64 that getView returns).
   */
  getReadout(): Readout {
    const d = this.coordDecimals();
    return {
      magnification: BASE_SCALE / this.scale,
      scale: this.scale,
      maxIter: this.maxIter,
      fps: this.fps,
      centerRe: toDecimalString(this.center.re, d),
      centerIm: toDecimalString(this.center.im, d),
    };
  }

  /**
   * Absolute complex coordinate under a CSS-pixel position, as full-precision
   * decimal strings. The pixel offset is small, so folding it into the
   * high-precision center keeps every meaningful digit even at deep zoom.
   */
  complexStringAt(cssX: number, cssY: number): { re: string; im: string } {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const nx = (cssX - 0.5 * cw) / ch;
    const ny = (0.5 * ch - cssY) / ch;
    const re = this.center.re + fromNumber(nx * this.scale);
    const im = this.center.im + fromNumber(ny * this.scale);
    const d = this.coordDecimals();
    return { re: toDecimalString(re, d), im: toDecimalString(im, d) };
  }

  /**
   * Decimal places to show for coordinates, scaled to the current zoom depth.
   * Capped at 300 to stay within FRAC=1024's ~308-digit real resolution.
   */
  private coordDecimals(): number {
    const magnification = BASE_SCALE / this.scale;
    return Math.min(300, Math.max(6, Math.ceil(Math.log10(magnification)) + 5));
  }

  /** Pan by a pixel delta (CSS px); the grabbed point follows the cursor. */
  panByPixels(dxCss: number, dyCss: number): void {
    const k = this.scale / this.canvas.clientHeight;
    // Accumulate the (small) shift into the high-precision center exactly.
    this.center.re -= fromNumber(dxCss * k);
    this.center.im += fromNumber(dyCss * k); // flip y
    this.orbitDirty = true;
  }

  /**
   * Zoom by `factor` about a cursor position (CSS px): < 1 zooms in, > 1 out.
   * The complex point under the cursor stays fixed. The center shift is
   * uv·(scaleOld − scaleNew), independent of the (deep) center, so it's a small
   * value we can fold into the high-precision center exactly.
   */
  zoomAt(cssX: number, cssY: number, factor: number): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const nx = (cssX - 0.5 * cw) / ch;
    const ny = (0.5 * ch - cssY) / ch;
    const dScale = this.scale - this.scale * factor;
    this.center.re += fromNumber(nx * dScale);
    this.center.im += fromNumber(ny * dScale);
    this.scale *= factor;
    this.orbitDirty = true;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.render();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  render(): void {
    // Frame-to-frame interval -> smoothed fps. Gaps over 500ms count as idle
    // (on-demand rendering), so we leave the last value rather than spike.
    const now = performance.now();
    if (this.lastFrameTime !== 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0 && dt < 500) {
        const inst = 1000 / dt;
        this.fps = this.fps === 0 ? inst : this.fps * 0.85 + inst * 0.15;
      }
    }
    this.lastFrameTime = now;

    if (this.orbitDirty) {
      this.updateReferenceOrbit();
      this.orbitDirty = false;
    }
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.refTexture);
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    // Pass scale as mantissa · 2^exponent so a deep (sub-f32) scale survives.
    const s = frexp(this.scale);
    gl.uniform1f(this.uScaleM, s.mantissa);
    gl.uniform1i(this.uScaleE, s.exponent);
    gl.uniform1i(this.uMaxIter, this.maxIter);
    gl.uniform1i(this.uRefLen, this.refLen);
    // Coloring (redraw-only; never touches the reference orbit).
    gl.uniform1i(this.uColorMode, COLOR_MODE_IDS[this.color.mode]);
    gl.uniform1i(this.uPalette, this.color.palette);
    gl.uniform1f(this.uCycle, this.color.cycle);
    gl.uniform1f(this.uOffset, this.color.offset);
    gl.uniform1f(this.uStripe, this.color.stripe);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.onViewChange?.(this.getView());
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.refTexture);
  }

  /** Recompute the reference orbit (CPU, high precision) and upload it. */
  private updateReferenceOrbit(): void {
    const orbit = computeReferenceOrbit(this.center.re, this.center.im, this.maxIter);
    this.refLen = orbit.length;

    const width = REF_TEX_WIDTH;
    const height = Math.max(1, Math.ceil(orbit.length / width));
    const padded = new Float32Array(width * height * 2);
    padded.set(orbit.data);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.refTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, padded);
  }

  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = this.compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);

    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program.');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
      gl.deleteProgram(program);
      throw new Error('Program link error:\n' + log);
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error';
      gl.deleteShader(shader);
      throw new Error('Shader compile error:\n' + log);
    }
    return shader;
  }
}