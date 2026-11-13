// How long each monitor's recent collection cycles took, kept in memory for the self-monitor to read.

// How many recent cycles the average and maximum cover.
export const CYCLE_WINDOW = 20;

// One monitor's recent cycle durations in seconds, and how long its SSH commands queued for a channel.
export interface CycleTiming {
  readonly last_seconds: number;
  readonly avg_seconds: number;
  readonly max_seconds: number;
  readonly last_wait_seconds: number;
  readonly avg_wait_seconds: number;
  readonly cycles: number;
}

// A short window of cycle durations per monitor.
export class CycleStats {
  private readonly window: number;
  private readonly samples = new Map<string, [seconds: number, wait_seconds: number][]>();

  constructor(window = CYCLE_WINDOW) {
    this.window = window;
  }

  record(plugin_id: string, seconds: number, wait_seconds = 0): void {
    let samples = this.samples.get(plugin_id);
    if (samples === undefined) {
      samples = [];
      this.samples.set(plugin_id, samples);
    }
    samples.push([seconds, wait_seconds]);
    if (samples.length > this.window) samples.shift();
  }

  get(plugin_id: string): CycleTiming | null {
    const samples = this.samples.get(plugin_id);
    if (!samples || samples.length === 0) return null;
    const durations = samples.map(([seconds]) => seconds);
    const waits = samples.map(([, wait]) => wait);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    return {
      last_seconds: durations[durations.length - 1],
      avg_seconds: sum(durations) / durations.length,
      max_seconds: Math.max(...durations),
      last_wait_seconds: waits[waits.length - 1],
      avg_wait_seconds: sum(waits) / waits.length,
      cycles: samples.length,
    };
  }

  forget(plugin_id: string): void {
    this.samples.delete(plugin_id);
  }
}
