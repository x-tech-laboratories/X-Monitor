// The change bus: every semantic write on the Database Engine publishes one change, tagged with its kind and the
// monitor it belongs to, and the page's event stream and the exporters react to it instead of polling.

import { create_logger_for } from "../logging.ts";

const log = create_logger_for("x_monitor.core.state.changes");

export const STATUS = "status";
export const METRIC = "metric";
export const EVENT = "event";
export const LOG = "log";
export const JOB = "job";
export const SNAPSHOT = "snapshot";
export const SETTING = "setting";
// The set of monitors itself changed, after a config reload.
export const MONITORS = "monitors";

export type ChangeKind = typeof STATUS | typeof METRIC | typeof EVENT | typeof LOG | typeof JOB | typeof SNAPSHOT | typeof SETTING | typeof MONITORS;

// Takes the kind and the monitor's id, null for a change that belongs to no single monitor.
export type Subscriber = (kind: ChangeKind, plugin_id: string | null) => void;

export class ChangeBus {
  private subscribers: Subscriber[] = [];

  // Registers the subscriber and returns what removes it.
  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.push(subscriber);
    return () => {
      this.subscribers = this.subscribers.filter((each) => each !== subscriber);
    };
  }

  publish(kind: ChangeKind, plugin_id: string | null = null): void {
    for (const subscriber of this.subscribers) {
      // One failing subscriber must not poison the bus for the others or the publisher.
      try {
        subscriber(kind, plugin_id);
      } catch (error) {
        log.error(`change subscriber failed for '${kind}': ${(error as Error).message}`);
      }
    }
  }
}

// One bus per process, so the Database Engine and its readers need not hold each other.
export const CHANGES = new ChangeBus();
