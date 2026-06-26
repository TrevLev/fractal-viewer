import vertSource from './shaders/fractal.vert.glsl?raw';
import fragSource from './shaders/fractal.frag.glsl?raw';

export interface View {
  /** View center in the complex plane: [real, imaginary]. */
  center: [number, number];
  /** Vertical extent of the view, in complex-plane units. Smaller = zoomed in. */
  scale: number;
  /** Maximum escape-time iterations. */
  maxIter: number;
}

const DEFAULT_VIEW: View = {
  center: [-0.5, 0],
  scale: 2.6,
  maxIter: 300,
};

/**
 * Renders a fractal into a WebGL2 canvas.
 *
 * This class is deliberately framework-agnostic: it knows nothing about React
 * or the DOM beyond the canvas it's handed. The UI layer drives it through
 * setView() / render(). When the time comes to swap in WebGPU or
 * perturbation-theory deep zoom, this is the only file that changes — the UI
 * stays put.
 */
export class FractalRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private uResolution: WebGLUniformLocation | null;
  private uCenter: WebGLUniformLocation | null;
  private uScale: WebGLUniformLocation | null;
  private uMaxIter: WebGLUniformLocation | null;

  private view: View = { ...DEFAULT_VIEW };
  private maxDpr = 2; // cap device-pixel-ratio so 4K/Retina doesn't tank perf
  private frameRequested = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser.');
    }
    this.canvas = canvas;
    this.gl = gl;

    this.program = this.createProgram(vertSource, fragSource);
    gl.useProgram(this.program);

    // drawArrays needs a bound VAO in WebGL2, even with no vertex attributes.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create vertex array object.');
    this.vao = vao;
    gl.bindVertexArray(vao);

    this.uResolution = gl.getUniformLocation(this.program, 'uResolution');
    this.uCenter = gl.getUniformLocation(this.program, 'uCenter');
    this.uScale = gl.getUniformLocation(this.program, 'uScale');
    this.uMaxIter = gl.getUniformLocation(this.program, 'uMaxIter');
  }

  /** Current view, as a copy (safe to mutate without touching engine state). */
  getView(): View {
    return { ...this.view, center: [...this.view.center] };
  }

  /** Merge a partial view update. Does not render — call render()/requestRender(). */
  setView(partial: Partial<View>): void {
    this.view = { ...this.view, ...partial };
  }

  /** Match the drawing buffer to the canvas's displayed size, then render. */
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

  /** Coalesce multiple state changes within a frame into a single draw. */
  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  /** Draw immediately. */
  render(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uCenter, this.view.center[0], this.view.center[1]);
    gl.uniform1f(this.uScale, this.view.scale);
    gl.uniform1i(this.uMaxIter, this.view.maxIter);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Release GPU resources. */
  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
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

    // The shaders are owned by the program now; flag them for cleanup.
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
