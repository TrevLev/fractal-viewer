import { useEffect, useRef } from 'react';
import { FractalRenderer } from '../engine/FractalRenderer';

/**
 * Owns the <canvas> and the renderer's lifecycle, and wires pointer/wheel
 * input to the engine. Stays thin: it translates DOM events into engine calls
 * (panByPixels / zoomAt) and never touches GL or the view math itself.
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
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(canvas);

    // --- drag to pan ---
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // left button only
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      // Pixel deltas are origin-independent, so no bounding-rect needed here.
      renderer.panByPixels(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.requestRender();
    };

    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      canvas.style.cursor = 'grab';
    };

    // --- wheel to zoom, centered on the cursor ---
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // stop the page from scrolling
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Normalize line-mode deltas (Firefox) to roughly pixel scale.
      const unit = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.exp(e.deltaY * unit * 0.001); // up => <1 => zoom in
      renderer.zoomAt(x, y, factor);
      renderer.requestRender();
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="fractal-canvas" />;
}