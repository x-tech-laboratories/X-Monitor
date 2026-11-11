// A stat panel with its label and value laid out like any other and a small ring beside them, its 270° arc filled by
// the value's share of the whole in the colour the caller gives. Self-contained, so it can move to X-Libs.

const RADIUS = 21;
const SWEEP_DEGREES = 270;
const SWEEP_LENGTH = (2 * Math.PI * RADIUS * SWEEP_DEGREES) / 360;

export interface GaugeProps {
  label: string;
  // The value as text, such as "78.0%".
  value_text: string;
  // How full the arc is, 0 to 100.
  percent: number;
  // A CSS colour, normally a Halon token such as var(--status-danger).
  color: string;
  caption?: string | null;
}

// The arc's dash: `percent` of the sweep, or nothing for an empty gauge, since a zero-length round cap still shows.
export function gauge_dash(percent: number): string | null {
  if (percent <= 0) return null;
  return `${((SWEEP_LENGTH * Math.min(100, percent)) / 100).toFixed(2)} 999`;
}

export function Gauge({ label, value_text, percent, color, caption }: GaugeProps) {
  const dash = gauge_dash(percent);
  return (
    <div className="tile gauge-card">
      <div className="gauge-text">
        <span className="tile-label">{label}</span>
        <span className="tile-value">{value_text}</span>
        {caption ? <span className="muted small">{caption}</span> : null}
      </div>
      <svg className="gauge-ring" viewBox="0 0 48 48" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={value_text}>
        <circle className="gauge-track" cx="24" cy="24" r={RADIUS} transform="rotate(135 24 24)" style={{ strokeDasharray: `${SWEEP_LENGTH.toFixed(2)} 999` }} />
        {dash !== null && <circle className="gauge-fill" cx="24" cy="24" r={RADIUS} transform="rotate(135 24 24)" style={{ stroke: color, strokeDasharray: dash }} />}
      </svg>
    </div>
  );
}
