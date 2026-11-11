// Tiles whose areas are their values, laid out by the squarified algorithm so each stays near square, each filled
// with the colour it names and labelled with its name and value; a click on a tile hands it back. Self-contained, so
// it can move to X-Libs.

export interface TreemapTile {
  name: string;
  value: number;
  // A CSS colour, normally a Halon token.
  color: string;
  title?: string;
}

export interface PlacedTile<Tile> {
  tile: Tile;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The worst aspect ratio of a row of areas laid along a side of `length`.
function worst_ratio(areas: number[], length: number): number {
  const total = areas.reduce((sum, area) => sum + area, 0);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  return Math.max((length * length * largest) / (total * total), (total * total) / (length * length * smallest));
}

// Places tiles, largest first, in a width by height box, as percentages of it.
export function squarify<Tile extends { value: number }>(tiles: readonly Tile[], width = 100, height = 100): PlacedTile<Tile>[] {
  const kept = [...tiles].filter((tile) => tile.value > 0).sort((left, right) => right.value - left.value);
  const total = kept.reduce((sum, tile) => sum + tile.value, 0);
  if (total === 0) return [];
  const scale = (width * height) / total;
  const placed: PlacedTile<Tile>[] = [];
  let box = { x: 0, y: 0, width, height };
  let row: Tile[] = [];

  const lay_row = (): void => {
    const areas = row.map((tile) => tile.value * scale);
    const sum = areas.reduce((total_area, area) => total_area + area, 0);
    const across = box.width >= box.height;
    const thickness = across ? sum / box.height : sum / box.width;
    let offset = 0;
    row.forEach((tile, index) => {
      const length = areas[index] / thickness;
      placed.push(across
        ? { tile, x: box.x, y: box.y + offset, width: thickness, height: length }
        : { tile, x: box.x + offset, y: box.y, width: length, height: thickness });
      offset += length;
    });
    box = across ? { x: box.x + thickness, y: box.y, width: box.width - thickness, height: box.height } : { x: box.x, y: box.y + thickness, width: box.width, height: box.height - thickness };
    row = [];
  };

  for (const tile of kept) {
    const side = Math.min(box.width, box.height);
    const areas = row.map((each) => each.value * scale);
    if (row.length === 0 || worst_ratio([...areas, tile.value * scale], side) <= worst_ratio(areas, side)) row.push(tile);
    else {
      lay_row();
      row.push(tile);
    }
  }
  if (row.length > 0) lay_row();
  return placed;
}

export function Treemap({ label, tiles, on_select, selected = null }: { label: string; tiles: TreemapTile[]; on_select?: (tile: TreemapTile) => void; selected?: string | null }) {
  const placed = squarify(tiles);
  return (
    <div className="treemap" role="group" aria-label={label}>
      {placed.map(({ tile, x, y, width, height }) => (
        <button
          key={tile.name}
          type="button"
          className="treemap-tile"
          aria-pressed={selected === tile.name}
          title={tile.title ?? `${tile.name}: ${tile.value}`}
          style={{ left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%`, background: tile.color }}
          onClick={() => on_select?.(tile)}
        >
          <span className="treemap-name">{tile.name}</span>
          <span className="treemap-value">{tile.value}</span>
        </button>
      ))}
    </div>
  );
}
