import { useEffect, useRef, useState } from 'react';
import {
  FractalRenderer,
  type Readout,
  type ColorSettings,
  type Snapshot,
} from '../engine/FractalRenderer';
import { Hud, type HudController } from './Hud';

interface CursorReadout {
  re: string;
  im: string;
}

/**
 * Owns the <canvas> and the renderer's lifecycle, wires pointer/wheel input to
 * the engine, and exposes a small controller so the HUD can drive the engine
 * (typed coordinates, iterations, color) without ever touching GL itself. The
 * engine stays the single source of truth; React state here just mirrors it so
 * the controls can render the current values.
 */
export function FractalCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FractalRenderer | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [cursor, setCursor] = useState<CursorReadout | null>(null);
  const [color, setColor] = useState<ColorSettings | null>(null);
  const [maxIter, setMaxIter] = useState(512);

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
    rendererRef.current = renderer;

    // The engine fires this after every frame; pull a fresh display snapshot.
    renderer.onViewChange = () => setReadout(renderer.getReadout());
    setReadout(renderer.getReadout());
    setColor(renderer.getColor());
    setMaxIter(renderer.getView().maxIter);

    // Cache the canvas rect (for cursor coords) and refresh it when geometry
    // could have moved, instead of forcing a layout on every pointer move.
    let rect = canvas.getBoundingClientRect();
    const refreshRect = () => {
      rect = canvas.getBoundingClientRect();
    };

    const observer = new ResizeObserver(() => {
      renderer.resize();
      refreshRect();
    });
    observer.observe(canvas);
    window.addEventListener('scroll', refreshRect, { passive: true });

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
      if (dragging) {
        // Pixel deltas are origin-independent, so no rect needed for the pan.
        renderer.panByPixels(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        renderer.requestRender();
      }
      setCursor(renderer.complexStringAt(e.clientX - rect.left, e.clientY - rect.top));
    };

    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      canvas.style.cursor = 'grab';
    };

    const onPointerLeave = () => {
      if (!dragging) setCursor(null);
    };

    // --- wheel to zoom, centered on the cursor ---
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // stop the page from scrolling
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
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', refreshRect);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Controller: UI -> engine, keeping the mirrored React state in sync so the
  // controls always show the engine's current values.
  const controller: HudController = {
    setCenter(re, im) {
      const r = rendererRef.current;
      if (!r) return false;
      try {
        r.setCenter(re, im);
      } catch {
        return false; // unparseable coordinates — leave the view where it is
      }
      r.requestRender();
      return true;
    },
    setMagnification(mag) {
      const r = rendererRef.current;
      if (!r) return;
      r.setMagnification(mag);
      r.requestRender();
    },
    setMaxIter(n) {
      const r = rendererRef.current;
      if (!r) return;
      r.setMaxIter(n);
      setMaxIter(r.getView().maxIter);
      r.requestRender();
    },
    setColor(c) {
      const r = rendererRef.current;
      if (!r) return;
      r.setColor(c);
      setColor(r.getColor());
      r.requestRender();
    },
    async copySnapshot() {
      const r = rendererRef.current;
      if (!r) return false;
      try {
        await navigator.clipboard.writeText(JSON.stringify(r.getSnapshot()));
        return true;
      } catch {
        return false;
      }
    },
    loadSnapshotText(text) {
      const r = rendererRef.current;
      if (!r) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return false;
      }
      if (!parsed || typeof parsed !== 'object') return false;
      try {
        r.applySnapshot(parsed as Partial<Snapshot>);
      } catch {
        return false;
      }
      setColor(r.getColor());
      setMaxIter(r.getView().maxIter);
      setReadout(r.getReadout());
      r.requestRender();
      return true;
    },
  };

  return (
    <>
      <canvas ref={canvasRef} className="fractal-canvas" />
      <Hud
        readout={readout}
        cursor={cursor}
        color={color}
        maxIter={maxIter}
        controller={controller}
      />
    </>
  );
}
