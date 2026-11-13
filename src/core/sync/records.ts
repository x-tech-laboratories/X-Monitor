// Encoding and decoding of an agent's records. A record is one write the agent made, a collection result, one step of
// a detached job, or a setting, as a (kind, payload) pair of plain JSON values, kept in the agent's outbox and sent to
// the server as it is. Encoding is pure, so the agent and the server share it.

import { CollectResult, type LogEntry, type LogLineEntry } from "../connectors/types.ts";

export const RESULT = "result";
export const JOB = "job";
export const SETTING = "setting";

// The job steps a record can carry, matching the database's job writes.
export const JOB_CREATE = "create";
export const JOB_PID = "pid";
export const JOB_PROGRESS = "progress";
export const JOB_OUTPUT = "output";
export const JOB_OUTPUT_SEQ = "output_seq";
export const JOB_FINISH = "finish";

export type RecordPayload = Record<string, unknown>;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

// A local time as Python's datetime.isoformat() wrote it, such as "2026-11-11T09:30:05.123000".
export function python_isoformat(moment: Date): string {
  const base = `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}T${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}`;
  const milliseconds = moment.getMilliseconds();
  return milliseconds ? `${base}.${String(milliseconds).padStart(3, "0")}000` : base;
}

// Reads python_isoformat's text back as a local Date.
export function parse_isoformat(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid isoformat string: '${text}'`);
    return parsed;
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), fraction ? Math.floor(Number(fraction.padEnd(6, "0")) / 1000) : 0);
}

// A collection result as a record, stamped with when it was observed.
export function encode_result(target: string, plugin_id: string, plugin_name: string, result: CollectResult, now: Date | null = null): [string, RecordPayload] {
  const observed = result.timestamp ?? now ?? new Date();
  return [RESULT, {
    target,
    plugin_id,
    plugin_name,
    ts: python_isoformat(observed),
    metrics: { ...result.metrics },
    metadata: { ...result.metadata },
    logs: result.logs.map((entry) => [...entry]),
    log_lines: result.log_lines.map((entry) => [...entry]),
    status: result.status,
    snapshot: result.snapshot,
    settings: { ...result.settings },
  }];
}

function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// A result record back as (target, plugin id, plugin name, CollectResult) carrying its original time.
export function decode_result(payload: RecordPayload): [string, string, string, CollectResult] {
  const result = new CollectResult({
    metrics: Object.fromEntries(Object.entries(mapping(payload.metrics)).map(([key, value]) => [key, Number(value)])),
    metadata: Object.fromEntries(Object.entries(mapping(payload.metadata)).map(([key, value]) => [key, String(value)])),
    logs: ((payload.logs as unknown[][] | null) ?? []).map(([message, level]): LogEntry => [String(message), String(level)]),
    log_lines: ((payload.log_lines as unknown[][] | null) ?? []).map(([message, level, log_time]): LogLineEntry => [String(message), String(level), (log_time as string | null) ?? null]),
    status: (payload.status as string | null | undefined) ?? null,
    snapshot: payload.snapshot ?? null,
    settings: Object.fromEntries(Object.entries(mapping(payload.settings)).map(([key, value]) => [key, String(value)])),
    timestamp: parse_isoformat(String(payload.ts)),
  });
  return [String(payload.target), String(payload.plugin_id), String(payload.plugin_name), result];
}

// One step of a detached job as a record, under the agent's own job id.
export function encode_job(step: string, job_id: number, fields: RecordPayload = {}, now: Date | null = null): [string, RecordPayload] {
  return [JOB, { step, job_id, ts: python_isoformat(now ?? new Date()), ...fields }];
}

// A setting the agent wrote, such as a scheduled run's outcome, as a record.
export function encode_setting(key: string, value: string): [string, RecordPayload] {
  return [SETTING, { key, value }];
}
