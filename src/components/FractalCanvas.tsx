import { useEffect, useRef } from 'react';
import { FractalRenderer } from '../engine/FractalRenderer';

/**
 * Owns the <canvas> and the renderer's lifecycle. Intentionally thin: it wires
 * the engine to the DOM and nothing more. Future UI (pan/zoom handlers,
 * sliders, export) hangs off this component and the renderer it holds.
 */
export function FractalCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: FractalRenderer;
    try {
      renderer = new FractalRenderer(canvas);
    } catch (err) {
      console.error('Failed to initialize fractal renderer:', err);
      return;
    }

    // Keep the drawing buffer in sync with the canvas's displayed size.
    // ResizeObserver fires once on observe(), giving us the initial paint.
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="fractal-canvas" />;
}
