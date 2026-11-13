// Collects what the app logs during a test, as pytest's caplog did.

import type { LogRecord } from "@x-tech-laboratories/x-libs/log";
import { afterEach, beforeEach } from "vitest";

import { set_log_sink } from "../../src/core/logging.ts";

export interface LogCapture {
  records: LogRecord[];
  // Every message, one per line.
  text(): string;
  clear(): void;
}

// Captures every record from before each test until after it; call at the top of a describe block or file.
export function capture_logs(): LogCapture {
  const capture: LogCapture = {
    records: [],
    text: () => capture.records.map((record) => `${record.level.toUpperCase()} ${record.scope}: ${record.message}`).join("\n"),
    clear: () => {
      capture.records.length = 0;
    },
  };
  beforeEach(() => {
    capture.records.length = 0;
    set_log_sink((record) => capture.records.push(record));
  });
  afterEach(() => {
    set_log_sink(() => {});
  });
  return capture;
}
