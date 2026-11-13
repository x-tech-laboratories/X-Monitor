// The canonical monitor status ladder, shared by the server, the agent and the page.
//
// "info" ranks just above "online": the monitor is healthy but in a passing state worth seeing, such as a folder
// still syncing. "unavailable" ranks below "warning": a monitor that cannot measure is less alarming than one
// measuring a bad number. Only an availability monitor calls an unreachable host failed.

// ── Statuses ─────────────────────────────────────────────────────────────────

export const statuses = ["online", "info", "unavailable", "warning", "failed"] as const;

export type Status = (typeof statuses)[number];

const severities: Record<Status, number> = { online: 0, info: 1, unavailable: 2, warning: 3, failed: 4 };

const log_levels: Record<Status, LogLevel> = {
  online: "INFO", info: "INFO", unavailable: "WARNING", warning: "WARNING", failed: "ERROR",
};

// The levels a monitor's events and log lines carry, as the Python app wrote them.
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export function is_status(value: unknown): value is Status {
  return typeof value === "string" && Object.hasOwn(severities, value);
}

// The status a stored string means; "offline" is this status's old name, and anything unknown ranks as unavailable.
export function status_of(value: unknown): Status {
  if (value === "offline") return "unavailable";
  return is_status(value) ? value : "unavailable";
}

export function severity(status: Status): number {
  return severities[status];
}

export function log_level_of(status: Status): LogLevel {
  return log_levels[status];
}

// The most severe of the given statuses, online when there are none.
export function worst_status(values: Iterable<unknown>): Status {
  let worst: Status = "online";
  for (const value of values) {
    const candidate = status_of(value);
    if (severities[candidate] > severities[worst]) worst = candidate;
  }
  return worst;
}

// The least severe of the given statuses, online when there are none.
export function best_status(values: Iterable<unknown>): Status {
  let best: Status | null = null;
  for (const value of values) {
    const candidate = status_of(value);
    if (best === null || severities[candidate] < severities[best]) best = candidate;
  }
  return best ?? "online";
}
