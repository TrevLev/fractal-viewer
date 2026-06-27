import vertSource from './shaders/fractal.vert.glsl?raw';
import fragSource from './shaders/fractal.frag.glsl?raw';
import {
  fromNumber,
  toNumber,
  toDecimalString,
  frexp,
  computeReferenceOrbit,
} from './HighPrecision';

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

  // Center is high precision; scale/maxIter are ordinary numbers (f64's range
  // is plenty for scale — the depth limit is the GPU's f32 deltas, not this).
  private center = { re: fromNumber(-0.5), im: fromNumber(0) };
  private scale = BASE_SCALE;
  private maxIter = 512;

  private maxDpr = 2;
  private frameRequested = false;
  private viewDirty = true; // reference orbit needs recomputing
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
    }
    if (partial.scale !== undefined) this.scale = partial.scale;
    if (partial.maxIter !== undefined) this.maxIter = partial.maxIter;
    this.viewDirty = true;
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
   * Map a CSS-pixel position (pointer-event coords) to a point in the complex
   * plane. Approximate at extreme depth (returns f64), but fine for read-outs.
   */
  screenToComplex(cssX: number, cssY: number): [number, number] {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const nx = (cssX - 0.5 * cw) / ch;
    const ny = (0.5 * ch - cssY) / ch;
    return [
      toNumber(this.center.re) + nx * this.scale,
      toNumber(this.center.im) + ny * this.scale,
    ];
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
   * Capped at 76 to stay within FRAC=256's ~77-digit real resolution.
   */
  private coordDecimals(): number {
    const magnification = BASE_SCALE / this.scale;
    return Math.min(76, Math.max(6, Math.ceil(Math.log10(magnification)) + 5));
  }

  /** Pan by a pixel delta (CSS px); the grabbed point follows the cursor. */
  panByPixels(dxCss: number, dyCss: number): void {
    const k = this.scale / this.canvas.clientHeight;
    // Accumulate the (small) shift into the high-precision center exactly.
    this.center.re -= fromNumber(dxCss * k);
    this.center.im += fromNumber(dyCss * k); // flip y
    this.viewDirty = true;
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
    this.viewDirty = true;
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

    if (this.viewDirty) {
      this.updateReferenceOrbit();
      this.viewDirty = false;
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