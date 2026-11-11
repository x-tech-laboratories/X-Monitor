// One bar split into parts by their shares of the whole, with each part's value in the legend beneath, since a share
// alone never says how many. Self-contained, so it can move to X-Libs.

export interface SharePart {
  label: string;
  // The part's value as text, printed in the legend.
  value_text: string;
  // The part's share of the bar, 0 to 100.
  percent: number;
  // A CSS colour, normally a Halon token.
  color: string;
}

export function ShareBar({ label, parts, show_values = true }: { label: string; parts: SharePart[]; show_values?: boolean }) {
  return (
    <div className="share-card">
      <span className="tile-label">{label}</span>
      <div className="share-bar" role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${part.value_text}`).join(", ")}`}>
        {parts.filter((part) => part.percent > 0).map((part) => (
          <span key={part.label} className="share-part" style={{ flexGrow: part.percent, background: part.color }} title={`${part.label} ${part.value_text}`} />
        ))}
      </div>
      <div className="legend-row">
        {parts.map((part) => (
          <span key={part.label} className="legend-item">
            <span className="legend-swatch" style={{ background: part.color }} />
            {show_values ? `${part.label} ${part.value_text}` : part.label}
          </span>
        ))}
      </div>
    </div>
  );
}
