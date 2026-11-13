// Custom actions: a monitor's `actions` list, each entry a shell command the user adds as a button on that monitor's
// page. Any monitor type accepts them. Parsing, planning and reading the outcome are pure; the engine runs the command
// over the monitor's own transport, or on the agent an entry names.

import { action_plan, CollectResult, type ActionPlan, type CmdResult } from "../../core/connectors/types.ts";
import type { ActionButtonSpec } from "../../shared/ui_spec.ts";
import { parse_duration } from "./plugin_helpers.ts";

// Prefix of every custom action's id, so one can never shadow an action the monitor itself offers.
export const ACTION_PREFIX = "custom:";

export const DEFAULT_ICON = "terminal";

// Characters of command output kept in the monitor's log line.
export const OUTPUT_LOG_LIMIT = 500;

// A display name as an id: lower case, with runs of other characters as one underscore.
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export class CustomAction {
  readonly action_id: string;
  readonly name: string;
  readonly command: string;
  readonly icon: string;
  readonly confirm: string | null;
  readonly danger: boolean;
  readonly timeout: number | null;
  readonly agent: string | null;
  readonly more: boolean;
  // Runs as a detached job that survives an X-Monitor restart, its output in a live log.
  readonly detached: boolean;

  constructor(fields: { action_id: string; name: string; command: string; icon?: string; confirm?: string | null; danger?: boolean; timeout?: number | null; agent?: string | null; more?: boolean; detached?: boolean }) {
    this.action_id = fields.action_id;
    this.name = fields.name;
    this.command = fields.command;
    this.icon = fields.icon ?? DEFAULT_ICON;
    this.confirm = fields.confirm ?? null;
    this.danger = fields.danger ?? false;
    this.timeout = fields.timeout ?? null;
    this.agent = fields.agent ?? null;
    this.more = fields.more ?? false;
    this.detached = fields.detached ?? false;
  }

  // The header button this action shows as.
  button(): ActionButtonSpec {
    const spec: ActionButtonSpec = { action_id: this.action_id, name: this.name, icon: this.icon };
    if (this.danger) spec.variant = "danger";
    if (this.confirm) spec.confirm = this.confirm;
    if (this.more) spec.more = true;
    if (this.detached) spec.detached = true;
    return spec;
  }

  plan(): ActionPlan {
    return action_plan(this.command, { timeout: this.timeout, agent: this.agent, detached: this.detached });
  }

  // Succeeds on exit code 0, and logs the outcome with the command's output on the monitor.
  interpret(result: CmdResult): CollectResult {
    const success = result.exit_code === 0;
    let output = success ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim();
    if (output.length > OUTPUT_LOG_LIMIT) output = `${output.slice(0, OUTPUT_LOG_LIMIT)}…`;
    let message = success ? `${this.name} ran` : `${this.name} failed (exit ${result.exit_code})`;
    if (output) message += `: ${output}`;
    return new CollectResult({ logs: [[message, success ? "INFO" : "ERROR"]], metadata: { content: result.stdout }, success });
  }
}

// Reads a monitor's `actions` list, throwing on a malformed entry.
export function parse_custom_actions(value: unknown): CustomAction[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error("`actions` must be a list of {name, command} entries");
  const actions: CustomAction[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    const record = entry as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || Array.isArray(record) || !record.name || !record.command) {
      throw new Error(`each \`actions\` entry needs a \`name\` and a \`command\`, not ${JSON.stringify(entry)}`);
    }
    const name = String(record.name);
    const key = slug(String(record.id || name));
    if (!key) throw new Error(`the action '${name}' needs an \`id\` made of letters or digits`);
    if (seen.has(key)) throw new Error(`two \`actions\` entries share the id '${key}'; give one its own \`id\``);
    seen.add(key);
    actions.push(new CustomAction({
      action_id: ACTION_PREFIX + key,
      name,
      command: String(record.command),
      icon: String(record.icon || DEFAULT_ICON),
      confirm: record.confirm ? String(record.confirm) : null,
      danger: Boolean(record.danger ?? false),
      timeout: record.timeout !== undefined && record.timeout !== null ? parse_duration(record.timeout, "timeout") : null,
      agent: record.agent ? String(record.agent) : null,
      more: Boolean(record.more ?? false),
      detached: Boolean(record.detached ?? false),
    }));
  }
  return actions;
}
