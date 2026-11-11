// The dialogs a monitor's page opens: a spec's read, edit and form dialogs, filled from the row they open on, and a
// job's live log, which keeps its job polled every few seconds while it is open.

import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FollowingOutput } from "@x-tech-laboratories/x-libs/web/react/following";
import { use_watch } from "@x-tech-laboratories/x-libs/web/react/watch";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { TableRow } from "@x-tech-laboratories/x-libs/web/tables";

import type { DialogFieldView, DialogView } from "../../shared/page_view.ts";
import { form_values, row_params, substitute } from "../../shared/page_view.ts";
import { calls, changes, type JobLog } from "../api.ts";
import { confirmed, notify_error } from "../ui.tsx";

// ── Job logs ─────────────────────────────────────────────────────────────────

// Seconds between renewals of an open log's watch, well inside the server's lease.
const RENEW_SECONDS = 10;

// Seconds between reads of a running job's output, as the server polls it this often while the log is open.
const FOLLOW_SECONDS = 2;

export function JobLogDialog({ monitor_id, first, on_close }: { monitor_id: string; first: JobLog; on_close: () => void }) {
  const [log, set_log] = useState(first);
  const [lines, set_lines] = useState(first.lines);
  const shown = useRef(first.lines.at(-1)?.seq ?? -1);
  const bumps = use_watch(changes);

  // While the dialog is open a running job is watched, so new lines arrive soon after they are written.
  useEffect(() => {
    if (!first.running) return;
    let lease: string | null = null;
    let ended = false;
    void calls.watch_job(monitor_id, first.id).then((answer) => {
      lease = answer.lease;
      if (ended && lease) void calls.end_watch(lease);
    }).catch(() => undefined);
    const renew = setInterval(() => { if (lease) void calls.renew_watch(lease).catch(() => undefined); }, RENEW_SECONDS * 1000);
    return () => {
      ended = true;
      clearInterval(renew);
      if (lease) void calls.end_watch(lease).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!log.running) return;
    let cancelled = false;
    const read = async () => {
      const next = await calls.job_log(monitor_id, first.id, shown.current).catch(() => null);
      if (cancelled || next === null) return;
      if (next.lines.length > 0) {
        shown.current = next.lines.at(-1)!.seq;
        set_lines((before) => [...before, ...next.lines]);
      }
      set_log(next);
    };
    void read();
    const timer = setInterval(() => void read(), FOLLOW_SECONDS * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [log.running, bumps]);

  return (
    <Dialog title={log.title} subtitle={log.summary} wide on_close={on_close} buttons={<button className="accent solid" onClick={on_close}>Close</button>}>
      <pre className="command">{log.command}</pre>
      {log.error && <p className="tone-bad">{log.error}</p>}
      {lines.length === 0 ? <p className="muted">No output</p> : <FollowingOutput text={lines.map((line) => line.message).join("\n")} active={log.running} toggle />}
    </Dialog>
  );
}

// Opens a job's log, or says the job is gone.
export async function open_job_log(monitor_id: string, job_id: number | null): Promise<void> {
  if (job_id === null) return;
  let first: JobLog;
  try {
    first = await calls.job_log(monitor_id, job_id, -1);
  } catch {
    toast("That job is no longer kept", { tone: "warn" });
    return;
  }
  open_dialog((close) => <JobLogDialog monitor_id={monitor_id} first={first} on_close={close} />);
}

// ── Spec dialogs ─────────────────────────────────────────────────────────────

function ReadDialog({ title, content, textarea, on_close }: { title: string; content: string; textarea: boolean; on_close: () => void }) {
  return (
    <Dialog title={title} wide on_close={on_close} buttons={<button onClick={on_close}>Close</button>}>
      {textarea ? <textarea className="output" readOnly value={content} aria-label={title} rows={Math.min(30, content.split("\n").length + 1)} /> : <pre className="output">{content}</pre>}
    </Dialog>
  );
}

function EditDialog({ monitor_id, dialog, row, title, content, on_close }: { monitor_id: string; dialog: DialogView; row: TableRow | null; title: string; content: string; on_close: () => void }) {
  const [text, set_text] = useState(content);
  const save = async () => {
    const args = { ...row_params(dialog.save_params, row), [dialog.save_content_kwarg]: text };
    try {
      const reply = await calls.run_action(monitor_id, String(dialog.save_action_id), args, dialog.save_action_id ?? "Save");
      toast(reply.success ? dialog.success_message : "Save failed", { tone: reply.success ? "good" : "bad" });
      if (reply.success) on_close();
    } catch (error) {
      notify_error(error);
    }
  };
  return (
    <Dialog title={title} wide on_close={on_close} buttons={<><button onClick={on_close}>Cancel</button><button className="accent solid" onClick={() => void save()}>Save</button></>}>
      <textarea className="output" aria-label={title} value={text} rows={Math.min(30, text.split("\n").length + 2)} onChange={(event) => set_text(event.currentTarget.value)} />
    </Dialog>
  );
}

function FormField({ field, value, on_change }: { field: DialogFieldView; value: unknown; on_change: (value: unknown) => void }) {
  if (field.type === "checkbox") {
    return <label className="check"><input type="checkbox" checked={Boolean(value)} onChange={(event) => on_change(event.currentTarget.checked)} />{field.label}</label>;
  }
  if (field.type === "select") {
    return (
      <label className="field">
        <span className="field-label">{field.label}</span>
        <select value={value === null || value === undefined ? "" : String(value)} onChange={(event) => on_change(event.currentTarget.value)}>
          {field.options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span className="field-label">{field.label}</span>
      <input type="text" value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => on_change(event.currentTarget.value)} />
    </label>
  );
}

function FormDialog({ monitor_id, dialog, row, title, on_close }: { monitor_id: string; dialog: DialogView; row: TableRow | null; title: string; on_close: () => void }) {
  const [inputs, set_inputs] = useState<Record<string, unknown>>(() => Object.fromEntries(dialog.fields.map((field) => [field.name, field.default])));
  const [output, set_output] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const values = form_values(inputs);
    if (dialog.confirm && !(await confirmed(substitute(dialog.confirm, { ...row, ...values })))) return;
    try {
      const reply = await calls.run_action(monitor_id, String(dialog.action_id), { ...row_params(dialog.params, row), ...values }, dialog.action_id ?? "");
      if (!reply.success) toast(reply.content || "Action failed", { tone: "bad" });
      if (reply.content) set_output(reply.content);
    } catch (error) {
      notify_error(error);
    }
  };
  return (
    <Dialog title={title} on_close={on_close} form={{ on_submit: (event) => void submit(event), submit_label: dialog.submit_label }} buttons={<button type="button" onClick={on_close}>Close</button>}>
      {dialog.fields.map((field) => <FormField key={field.name} field={field} value={inputs[field.name]} on_change={(value) => set_inputs((before) => ({ ...before, [field.name]: value }))} />)}
      {output && <textarea className="output" readOnly aria-label="Output" value={output} rows={Math.min(20, output.split("\n").length + 1)} />}
    </Dialog>
  );
}

// Opens one of a monitor's dialogs, on the row it was opened from when there is one.
export async function open_spec_dialog(monitor_id: string, dialogs: Record<string, DialogView> | undefined, dialog_name: string, row: TableRow | null = null): Promise<void> {
  const dialog = dialogs?.[dialog_name];
  if (dialog === undefined) {
    toast(`Unknown dialog ${JSON.stringify(dialog_name)}`, { tone: "bad" });
    return;
  }
  const title = substitute(dialog.title, row);
  try {
    if (dialog.kind === "read") {
      const reply = await calls.run_action(monitor_id, String(dialog.action_id), row_params(dialog.params, row), dialog.action_id ?? "");
      if (!reply.success) {
        toast(reply.content || "Action failed", { tone: "bad" });
        return;
      }
      if (reply.job_id !== null) {
        await open_job_log(monitor_id, reply.job_id);
        return;
      }
      open_dialog((close) => <ReadDialog title={title} content={reply.content} textarea={dialog.render === "textarea_readonly"} on_close={close} />);
      return;
    }
    if (dialog.kind === "edit") {
      const reply = await calls.run_action(monitor_id, String(dialog.load_action_id), row_params(dialog.load_params, row), dialog.load_action_id ?? "");
      if (!reply.success) {
        toast(reply.content || "Unable to load content", { tone: "bad" });
        return;
      }
      open_dialog((close) => <EditDialog monitor_id={monitor_id} dialog={dialog} row={row} title={title} content={reply.content} on_close={close} />);
      return;
    }
    open_dialog((close) => <FormDialog monitor_id={monitor_id} dialog={dialog} row={row} title={title} on_close={close} />);
  } catch (error) {
    notify_error(error);
  }
}
