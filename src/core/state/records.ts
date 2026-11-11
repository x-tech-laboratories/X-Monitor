// The records the StateStore holds. History records are frozen once made; a job is the one record its plugin's polls
// advance in place, and readers take a rendered dict through as_dict() rather than the record itself.

import { iso_local } from "../../shared/time.ts";

export interface MetricRecord {
  readonly target: string;
  readonly plugin_id: string;
  readonly metric_name: string;
  readonly value: number;
  readonly metadata: string | null;
  readonly timestamp: Date;
}

export interface EventRecord {
  readonly level: string;
  readonly message: string;
  readonly target: string | null;
  readonly plugin_id: string | null;
  readonly timestamp: Date;
}

export interface LogLineRecord {
  readonly target: string;
  readonly plugin_id: string;
  readonly level: string;
  readonly message: string;
  readonly dedup_hash: string;
  readonly timestamp: Date;
}

export interface StatusRecord {
  readonly plugin_id: string;
  readonly state: string;
  readonly timestamp: Date;
}

export interface JobOutputRecord {
  readonly seq: number;
  readonly stream: string;
  readonly message: string;
  readonly timestamp: Date;
}

// The shape the job panel renders; `duration` counts against now while the job runs.
export interface JobDict {
  id: number;
  plugin_id: string;
  target: string;
  kind: string;
  state: string;
  command: string;
  started: string;
  finished: string | null;
  duration: number;
  exit_code: number | null;
  progress: string | null;
  error: string | null;
  running: boolean;
  pid: number | null;
  workdir: string | null;
  output_seq: number;
}

export interface JobRecord {
  id: number;
  plugin_id: string;
  target: string;
  kind: string;
  state: string;
  command: string;
  started: Date;
  finished: Date | null;
  exit_code: number | null;
  progress: string | null;
  error: string | null;
  pid: number | null;
  workdir: string | null;
  output_seq: number;
}

export type JobFields = Partial<Omit<JobRecord, "id" | "plugin_id">>;

export function job_as_dict(record: JobRecord, now: Date = new Date()): JobDict {
  const end = record.finished ?? now;
  return {
    id: record.id,
    plugin_id: record.plugin_id,
    target: record.target,
    kind: record.kind,
    state: record.state,
    command: record.command,
    started: iso_local(record.started),
    finished: record.finished ? iso_local(record.finished) : null,
    duration: Math.max(0, Math.trunc((end.getTime() - record.started.getTime()) / 1000)),
    exit_code: record.exit_code,
    progress: record.progress,
    error: record.error,
    running: record.state === "running",
    pid: record.pid,
    workdir: record.workdir,
    output_seq: record.output_seq || 0,
  };
}
