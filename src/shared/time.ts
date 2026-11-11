// Times as the app writes them: local wall-clock text such as "2026-11-11 09:30:05", as the Python app's
// isoformat(sep=" ", timespec="seconds") did.

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function iso_local(moment: Date): string {
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}`;
}

// Reads text written by iso_local (or an ISO stamp) back as a Date, or null when it is not a time.
export function parse_local(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text.trim());
  if (match === null) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0));
}

// Seconds since the epoch, as Python's time.time() gives.
export function epoch_seconds(moment: Date = new Date()): number {
  return moment.getTime() / 1000;
}
