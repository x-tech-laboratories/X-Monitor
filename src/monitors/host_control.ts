// A host's power controls: its power profile and whether it can suspend, with actions to reboot, shut down, suspend,
// change the power profile and blink a locate LED or beep; boot entries and the next boot are X-Nix's. Config: allow
// (the actions to offer; every one is off unless listed), privilege (sudo, the default, or none), identify_method
// (ledctl or beep) and identify_device. A control surface rather than a health check: it is online whenever the host
// answers, and a host lacking one of the tools just shows that control as unavailable.

import { action_plan, command, CollectResult, CONNECT_FAILED, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { ButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { partition, split_lines, split_words } from "./base/text_parsing.ts";

export const ACTIONS = ["reboot", "shutdown", "suspend", "power_profile", "identify"];

const labels: Record<string, string> = { reboot: "Reboot", shutdown: "Shutdown", suspend: "Suspend", power_profile: "Power profile", identify: "Identify", identify_off: "Identify off" };

const systemctl_verbs: Record<string, string> = { reboot: "reboot", shutdown: "poweroff", suspend: "suspend" };

// Actions that take the host away, so a connection cut off after sending them means they worked.
const disconnecting = new Set(["reboot", "shutdown", "suspend"]);

// Transport errors that mean the command never reached the host.
const never_sent = [CONNECT_FAILED, "is not connected", "Agent send failed"];

const platform_profile = "/sys/firmware/acpi/platform_profile";

const default_layout: LayoutRow[] = [["host_card", "profile_card", "suspend_card"], ["controls"], ["events"]];

export interface PowerState {
  backend: string;
  current: string | null;
  profiles: string[];
}

interface HostSnapshot {
  power?: Partial<PowerState>;
  sleep_states?: string[];
  can_suspend?: boolean;
}

// ── Probes ───────────────────────────────────────────────────────────────────

function power_command(): string {
  return (
    'if out=$(powerprofilesctl list 2>/dev/null); then echo backend=ppd; printf "%s\\n" "$out"; ' +
    'elif out=$(tuned-adm list 2>/dev/null); then echo backend=tuned; printf "%s\\n" "$out"; ' +
    `elif [ -r ${platform_profile} ]; then echo backend=sysfs; ` +
    `echo "current=$(cat ${platform_profile})"; ` +
    `echo "choices=$(cat ${platform_profile}_choices 2>/dev/null)"; ` +
    "else echo backend=none; fi"
  );
}

// The power-profile backend, current profile and available profiles from the power command's output.
export function parse_power(stdout: string): PowerState {
  const lines = split_lines(stdout);
  let backend = lines.length > 0 && lines[0].startsWith("backend=") ? partition(lines[0], "=")[2].trim() : "none";
  const body = lines.slice(1);
  let current: string | null = null;
  let profiles: string[] = [];
  if (backend === "ppd") {
    for (const line of body) {
      const match = /^([* ]) (\S+):\s*$/.exec(line);
      if (!match) continue;
      profiles.push(match[2]);
      if (match[1] === "*") current = match[2];
    }
  } else if (backend === "tuned") {
    for (const line of body) {
      if (line.startsWith("- ")) profiles.push(split_words(line.slice(2))[0]);
      else if (line.startsWith("Current active profile:")) current = partition(line, ":")[2].trim() || null;
    }
  } else if (backend === "sysfs") {
    const values: Record<string, string> = {};
    for (const line of body) {
      if (!line.includes("=")) continue;
      const [key, , value] = partition(line, "=");
      values[key] = value;
    }
    current = (values.current ?? "").trim() || null;
    profiles = split_words(values.choices ?? "");
  } else {
    backend = "none";
  }
  return { backend, current, profiles };
}

// Whether the command reached the host and the connection was then cut, as a going-down host does.
function dropped(result: CmdResult): boolean {
  return result.exit_code === -1 && !never_sent.some((marker) => result.stderr.includes(marker));
}

function sudo_refused(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes("sudo:") && ["password is required", "not allowed", "terminal is required", "no tty", "not in the sudoers"].some((sign) => lowered.includes(sign));
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class HostControl extends Plugin {
  readonly allow: Set<string>;
  readonly privilege: "none" | "sudo";
  readonly identify_device: string | null;
  readonly identify_method: "ledctl" | "beep";

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.allow = new Set(((config.allow as unknown[] | null | undefined) || []).map(String));
    this.privilege = config.privilege === "none" ? "none" : "sudo";
    this.identify_device = (config.identify_device as string | null | undefined) ?? null;
    const method = (config.identify_method as string | null | undefined) || (this.identify_device ? "ledctl" : "beep");
    this.identify_method = method === "ledctl" || method === "beep" ? method : "beep";
  }

  private get privilege_prefix(): string {
    return this.privilege === "sudo" ? "sudo -n " : "";
  }

  override commands(): Command[] {
    return [command(power_command()), command("cat /sys/power/state")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const [power_result, sleep_result] = results;
    const power = parse_power(power_result.exit_code === 0 ? power_result.stdout : "");
    const states = sleep_result.exit_code === 0 ? split_words(sleep_result.stdout) : [];
    const can_suspend = states.includes("mem") || states.includes("freeze");
    return new CollectResult({
      metrics: { power_profiles: power.profiles.length, suspend_supported: can_suspend ? 1 : 0 },
      logs: [[`power profile ${power.current || "n/a"} (${power.backend}), suspend ${can_suspend ? "supported" : "unsupported"}`, "INFO"]],
      snapshot: { power, sleep_states: states, can_suspend },
      status: "online",
    });
  }

  // ── State read back for actions and the page ─────────────────────────────

  private state(): HostSnapshot {
    const snapshot = this.data ? this.data.latest_snapshot<HostSnapshot>() : null;
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : {};
  }

  get power_profiles(): string[] {
    return [...(this.state().power?.profiles || [])];
  }

  get current_profile(): string | null {
    return this.state().power?.current ?? null;
  }

  get can_suspend(): boolean {
    return Boolean(this.state().can_suspend);
  }

  get profile_text(): string {
    return this.current_profile || "n/a";
  }

  get suspend_text(): string {
    return this.can_suspend ? "Supported" : "Unsupported";
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  allowed(action: string): boolean {
    return this.allow.has(action);
  }

  // An action outcome logged to the events feed, leaving the monitor's status alone.
  private outcome(message: string, success: boolean, level: string | null = null): CollectResult {
    return new CollectResult({ logs: [[message, level || (success ? "INFO" : "ERROR")]], metadata: { content: message }, success });
  }

  private refuse(action_id: string, reason: string): CollectResult {
    return this.outcome(`${labels[action_id] ?? action_id} on ${this.target} refused: ${reason}`, false, "WARNING");
  }

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    const gate = action_id === "identify_off" ? "identify" : action_id;
    if (!ACTIONS.includes(gate)) return null;
    if (!this.allowed(gate)) return this.refuse(action_id, "not in allow");
    if (action_id in systemctl_verbs) return action_plan(`${this.privilege_prefix}systemctl ${systemctl_verbs[action_id]}`);
    if (action_id === "power_profile") return this.plan_power_profile(String(args.profile || ""));
    return this.plan_identify(action_id === "identify");
  }

  private plan_power_profile(profile: string): ActionPlanResult {
    const power = this.state().power ?? {};
    if (!(power.profiles || []).includes(profile)) return this.refuse("power_profile", `unknown profile ${JSON.stringify(profile)}`);
    const quoted = shell_quote(profile);
    if (power.backend === "ppd") return action_plan(`${this.privilege_prefix}powerprofilesctl set ${quoted}`);
    if (power.backend === "tuned") return action_plan(`${this.privilege_prefix}tuned-adm profile ${quoted}`);
    return action_plan(`echo ${quoted} | ${this.privilege_prefix}tee ${platform_profile} >/dev/null`);
  }

  private plan_identify(on: boolean): ActionPlanResult {
    if (this.identify_method === "ledctl") {
      if (!this.identify_device) return this.refuse(on ? "identify" : "identify_off", "identify_device is not set");
      return action_plan(`${this.privilege_prefix}ledctl ${on ? "locate" : "locate_off"}=${shell_quote(String(this.identify_device))}`);
    }
    if (!on) return this.refuse("identify_off", "a beep stops by itself");
    return action_plan(`if command -v beep >/dev/null 2>&1; then ${this.privilege_prefix}beep -r 5; else printf '\\a' | ${this.privilege_prefix}tee /dev/console >/dev/null; fi`);
  }

  private describe(action_id: string, args: Record<string, unknown>): string {
    const label = labels[action_id] ?? action_id;
    if (action_id === "power_profile") return `${label} ${args.profile === undefined || args.profile === null ? "None" : String(args.profile)} on ${this.target}`;
    return `${label} on ${this.target}`;
  }

  override interpret_action(action_id: string, result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    const what = this.describe(action_id, args);
    if (outcome.exit_code === 0) return this.outcome(`${what}: done`, true);
    if (disconnecting.has(action_id) && dropped(outcome)) return this.outcome(`${what}: sent, and the host dropped the connection as it went down`, true);
    const detail = (outcome.stderr || outcome.stdout).trim();
    if (sudo_refused(detail)) {
      const first = split_lines(detail)[0];
      return this.outcome(`${what} failed: sudo refused (${first}); allow this command for the X-Monitor user without a password, or set privilege: none`, false);
    }
    return this.outcome(`${what} failed: ${detail || `exit code ${outcome.exit_code}`}`, false);
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    const host = "{plugin.target}";
    const controls: ButtonSpec[] = [
      { id: "reboot", label: "Reboot", icon: "restart_alt", color: "negative", visible_if: (plugin) => (plugin as HostControl).allowed("reboot"), confirm: `Reboot ${host} now? Everything running on it stops.` },
      { id: "shutdown", label: "Shut Down", icon: "power_settings_new", color: "negative", visible_if: (plugin) => (plugin as HostControl).allowed("shutdown"), confirm: `Shut down ${host} now? It stays off until someone powers it on.` },
      { id: "suspend", label: "Suspend", icon: "bedtime", visible_if: (plugin) => (plugin as HostControl).allowed("suspend") && (plugin as HostControl).can_suspend, confirm: `Suspend ${host} now? It stays asleep until woken.` },
      { id: "power_profile", label: "Power Profile", icon: "speed", kind: "dialog", dialog: "power_profile", visible_if: (plugin) => (plugin as HostControl).allowed("power_profile") && (plugin as HostControl).power_profiles.length > 0 },
      { id: "identify", label: "Identify", icon: "emergency", visible_if: (plugin) => (plugin as HostControl).allowed("identify"), confirm: `Blink or beep ${host} so you can find it?` },
      { id: "identify_off", label: "Stop Identify", icon: "block", visible_if: (plugin) => (plugin as HostControl).allowed("identify") && (plugin as HostControl).identify_method === "ledctl", confirm: `Stop the locate LED on ${host}?` },
    ];
    return {
      layout: default_layout,
      cards: {
        profile_card: { title: "POWER PROFILE", value_attr: "profile_text", refresh: true },
        suspend_card: { title: "SUSPEND", value_attr: "suspend_text", refresh: true },
      },
      buttons: { controls },
      dialogs: {
        power_profile: {
          kind: "form", title: `Power profile: ${host}`, action_id: "power_profile", submit_label: "Set",
          fields: [{ name: "profile", label: "Profile", options_attr: "power_profiles", default_attr: "current_profile" }],
          confirm: `Switch ${host} to the {row[profile]} power profile?`,
        },
      },
      events: true,
    };
  }
}
