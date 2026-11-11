// Numbers as Python's format specs write them, so the server's text and the page's agree with what the Python app
// showed: fixed decimals with an exact tie rounded to even, and thousands grouped with commas.

// A number with fixed decimals as Python's "{:.Nf}" writes it, rounding an exact tie to even where toFixed rounds up.
export function format_fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "inf" : value < 0 ? "-inf" : "nan";
  const exact = Math.abs(value).toFixed(Math.min(100, digits + 40));
  const point = exact.indexOf(".");
  const tail = exact.slice(point + 1 + digits);
  if (!/^50*$/.test(tail)) return value.toFixed(digits);
  const kept = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
  const last_digit = Number(kept.replace(".", "").slice(-1));
  if (last_digit % 2 === 0) return (value < 0 ? "-" : "") + kept;
  return value.toFixed(digits);
}

// A number as Python's "{:,.Nf}" writes it: fixed decimals with commas between thousands.
export function format_grouped(value: number, digits: number): string {
  const text = format_fixed(value, digits);
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
