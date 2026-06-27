import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  PALETTE_NAMES,
  type Readout,
  type ColorSettings,
  type ColorMode,
} from '../engine/FractalRenderer';
import './Hud.css';

interface CursorReadout {
  re: string;
  im: string;
}

/** The HUD's contract with the engine — implemented by FractalCanvas. */
export interface HudController {
  /** Apply typed center coordinates (full precision). False if unparseable. */
  setCenter(re: string, im: string): boolean;
  /** Set zoom as a magnification factor vs. the default view. */
  setMagnification(mag: number): void;
  setMaxIter(n: number): void;
  setColor(c: Partial<ColorSettings>): void;
  /** Copy the current view to the clipboard. False if the browser blocks it. */
  copySnapshot(): Promise<boolean>;
  /** Restore a view from pasted text. False if it isn't a valid saved view. */
  loadSnapshotText(text: string): boolean;
}

const MODES: { id: ColorMode; label: string }[] = [
  { id: 'smooth', label: 'Smooth' },
  { id: 'angle', label: 'Angle' },
  { id: 'stripe', label: 'Stripe' },
];

function formatZoom(mag: number): string {
  if (mag < 10) return `${mag.toFixed(2)}×`;
  if (mag < 1e4) return `${Math.round(mag)}×`;
  return `${mag.toExponential(2).replace('e+', 'e')}×`;
}

function formatScale(scale: number): string {
  return scale.toExponential(2).replace('e+', 'e');
}

/** Editable representation of the current zoom for the position field. */
function magToField(mag: number): string {
  if (mag < 1e4) return mag < 10 ? mag.toFixed(2) : Math.round(mag).toString();
  return mag.toExponential(3).replace('e+', 'e');
}

export function Hud({
  readout,
  cursor,
  color,
  maxIter,
  controller,
}: {
  readout: Readout | null;
  cursor: CursorReadout | null;
  color: ColorSettings | null;
  maxIter: number;
  controller: HudController;
}) {
  const [open, setOpen] = useState(true);
  const [pos, setPos] = useState({ re: '', im: '', zoom: '' });
  const [loadText, setLoadText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  // Which position field is being edited, so a render doesn't stomp the typing.
  const focused = useRef<string | null>(null);

  useEffect(() => {
    if (!readout) return;
    setPos((prev) => ({
      re: focused.current === 're' ? prev.re : readout.centerRe,
      im: focused.current === 'im' ? prev.im : readout.centerIm,
      zoom:
        focused.current === 'zoom' ? prev.zoom : magToField(readout.magnification),
    }));
  }, [readout]);

  if (!readout || !color) return null;

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((s) => (s === msg ? null : s)), 1600);
  };

  const commitCenter = () => {
    if (!controller.setCenter(pos.re, pos.im)) flash("Couldn't read those coordinates");
  };
  const commitZoom = () => {
    const v = parseFloat(pos.zoom);
    if (Number.isFinite(v) && v > 0) controller.setMagnification(v);
    else flash('Zoom must be a positive number');
  };
  const onEnter =
    (commit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commit();
        (e.target as HTMLInputElement).blur();
      }
    };

  const copy = async () => {
    flash((await controller.copySnapshot()) ? 'Copied to clipboard' : "Couldn't copy");
  };
  const load = () => {
    if (controller.loadSnapshotText(loadText)) {
      flash('View loaded');
      setLoadText('');
    } else {
      flash("That doesn't look like a saved view");
    }
  };

  return (
    <div className="hud">
      <div className="hud-head">
        <span className="hud-title">fractal</span>
        <button
          className="hud-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse controls' : 'Expand controls'}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>

      <div className="hud-grid">
        <span className="hud-label">zoom</span>
        <span className="hud-value">{formatZoom(readout.magnification)}</span>
        <span className="hud-label">scale</span>
        <span className="hud-value">{formatScale(readout.scale)}</span>
        <span className="hud-label">fps</span>
        <span className="hud-value">
          {readout.fps > 0 ? Math.round(readout.fps) : '—'}
        </span>
      </div>

      {open && (
        <div className="hud-controls">
          <fieldset className="hud-set">
            <legend>position</legend>
            <Field
              label="re"
              value={pos.re}
              mono
              onChange={(v) => setPos((p) => ({ ...p, re: v }))}
              onFocus={() => (focused.current = 're')}
              onBlur={() => {
                focused.current = null;
                commitCenter();
              }}
              onKeyDown={onEnter(commitCenter)}
            />
            <Field
              label="im"
              value={pos.im}
              mono
              onChange={(v) => setPos((p) => ({ ...p, im: v }))}
              onFocus={() => (focused.current = 'im')}
              onBlur={() => {
                focused.current = null;
                commitCenter();
              }}
              onKeyDown={onEnter(commitCenter)}
            />
            <Field
              label="zoom"
              value={pos.zoom}
              onChange={(v) => setPos((p) => ({ ...p, zoom: v }))}
              onFocus={() => (focused.current = 'zoom')}
              onBlur={() => {
                focused.current = null;
                commitZoom();
              }}
              onKeyDown={onEnter(commitZoom)}
            />
            <div className="hud-row hud-buttons">
              <button onClick={copy}>Copy view</button>
            </div>
            <div className="hud-row">
              <input
                className="hud-input hud-load"
                placeholder="paste a saved view…"
                spellCheck={false}
                value={loadText}
                onChange={(e) => setLoadText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load();
                }}
              />
              <button onClick={load} disabled={!loadText.trim()}>
                Load
              </button>
            </div>
          </fieldset>

          <fieldset className="hud-set">
            <legend>iterations</legend>
            <div className="hud-row">
              <input
                type="range"
                min={50}
                max={5000}
                step={50}
                value={Math.min(5000, maxIter)}
                onChange={(e) => controller.setMaxIter(parseInt(e.target.value, 10))}
              />
              <input
                className="hud-input hud-num-input"
                type="number"
                min={1}
                step={50}
                value={maxIter}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) controller.setMaxIter(n);
                }}
              />
            </div>
          </fieldset>

          <fieldset className="hud-set">
            <legend>color</legend>
            <div className="hud-row">
              <label className="hud-ctl-label">method</label>
              <select
                value={color.mode}
                onChange={(e) =>
                  controller.setColor({ mode: e.target.value as ColorMode })
                }
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hud-row">
              <label className="hud-ctl-label">palette</label>
              <select
                value={color.palette}
                onChange={(e) =>
                  controller.setColor({ palette: parseInt(e.target.value, 10) })
                }
              >
                {PALETTE_NAMES.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <Slider
              label="cycle"
              min={0.01}
              max={1}
              step={0.005}
              value={color.cycle}
              onChange={(v) => controller.setColor({ cycle: v })}
            />
            <Slider
              label="offset"
              min={0}
              max={1}
              step={0.005}
              value={color.offset}
              onChange={(v) => controller.setColor({ offset: v })}
            />
            {color.mode === 'stripe' && (
              <Slider
                label="density"
                min={1}
                max={16}
                step={0.5}
                value={color.stripe}
                onChange={(v) => controller.setColor({ stripe: v })}
              />
            )}
          </fieldset>

          <Coord label="cursor" re={cursor?.re ?? '—'} im={cursor?.im ?? '—'} />
        </div>
      )}

      {status && <div className="hud-status">{status}</div>}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onChange: (v: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="hud-row">
      <label className="hud-ctl-label">{label}</label>
      <input
        className={mono ? 'hud-input hud-mono' : 'hud-input'}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="hud-row">
      <label className="hud-ctl-label">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="hud-ctl-val">{value.toFixed(2)}</span>
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
