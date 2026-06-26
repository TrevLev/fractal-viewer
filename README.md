# Fractal Viewer

A WebGL2 explorer for quasi-self-similar fractals (Mandelbrot to start). The
heavy lifting happens in a fragment shader that runs the escape-time iteration
once per pixel, on the GPU, over a single full-screen triangle.

This first commit renders a static, smooth-colored Mandelbrot. No controls yet —
that's intentional.

## Stack

- **Vite + React + TypeScript** — client-only SPA, static deploy.
- **WebGL2 / GLSL ES 3.00** — the fragment shader is the actual renderer.

## Architecture

The one rule worth keeping: **the render engine knows nothing about React.**

- `src/engine/FractalRenderer.ts` — plain TS class. Owns the GL context,
  program, uniforms, and the draw call. Driven via `setView()` / `render()`.
- `src/engine/shaders/*.glsl` — vertex (full-screen triangle) and fragment
  (Mandelbrot + smooth coloring), imported as raw strings.
- `src/components/FractalCanvas.tsx` — thin React wrapper: mounts the canvas,
  owns the renderer's lifecycle, keeps the drawing buffer sized.

UI features (sliders, animation, export) attach to this seam without touching
GL code. Swapping the engine for WebGPU or perturbation-theory deep zoom later
means rewriting `FractalRenderer` and leaving the UI untouched.

## Develop

```bash
npm install
npm run dev      # dev server with HMR
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
```

## Roadmap

- [ ] Pan & zoom (wheel + drag) — also the way to *feel* the f32 precision wall
- [ ] Iteration count that scales with zoom depth
- [ ] Swappable coloring methods + palette editor
- [ ] More fractals (Julia, Burning Ship, multibrot) — one shader line each
- [ ] Animation keyframing + export (WebCodecs)
- [ ] Deep zoom: double-float emulation, then perturbation + series approximation
