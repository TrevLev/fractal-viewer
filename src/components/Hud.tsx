import type { Readout } from '../engine/FractalRenderer';
import './Hud.css';

interface CursorReadout {
  re: string;
  im: string;
}

/** Compact zoom read-out, e.g. "1.00×", "850×", "2.43e7×". */
function formatZoom(mag: number): string {
  if (mag < 10) return `${mag.toFixed(2)}×`;
  if (mag < 1e4) return `${Math.round(mag)}×`;
  return `${mag.toExponential(2).replace('e+', 'e')}×`;
}

/** Scale as a tidy exponential, e.g. "2.60e0", "1.00e-6". */
function formatScale(scale: number): string {
  return scale.toExponential(2).replace('e+', 'e');
}

export function Hud({
  readout,
  cursor,
}: {
  readout: Readout | null;
  cursor: CursorReadout | null;
}) {
  if (!readout) return null;

  return (
    <div className="hud">
      <div className="hud-grid">
        <span className="hud-label">zoom</span>
        <span className="hud-value">{formatZoom(readout.magnification)}</span>
        <span className="hud-label">scale</span>
        <span className="hud-value">{formatScale(readout.scale)}</span>
        <span className="hud-label">iter</span>
        <span className="hud-value">{readout.maxIter.toLocaleString()}</span>
        <span className="hud-label">fps</span>
        <span className="hud-value">
          {readout.fps > 0 ? Math.round(readout.fps) : '—'}
        </span>
      </div>

      <Coord label="center" re={readout.centerRe} im={readout.centerIm} />
      <Coord label="cursor" re={cursor?.re ?? '—'} im={cursor?.im ?? '—'} />
    </div>
  );
}

function Coord({ label, re, im }: { label: string; re: string; im: string }) {
  return (
    <div className="hud-coord">
      <div className="hud-coord-label">{label}</div>
      <div className="hud-num">
        <span className="hud-axis">re</span>
        <span className="hud-digits">{re}</span>
      </div>
      <div className="hud-num">
        <span className="hud-axis">im</span>
        <span className="hud-digits">{im}</span>
      </div>
    </div>
  );
}