// The small pieces every view shares: a status's tone, a value marked with its status, the toast after an action,
// and asking before one runs.

import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { ConfirmDialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { color_for, STATUS_COLORS } from "../shared/charts.ts";
import type { ActionReply } from "../shared/page_view.ts";
import { state_mark } from "../shared/page_view.ts";

// ── Status ───────────────────────────────────────────────────────────────────

const TONES: Record<string, Tone> = { online: "good", info: "info", warning: "warn", failed: "bad", unavailable: "none", offline: "none" };

export function tone_of(state: string | null | undefined): Tone {
  return state ? (TONES[state] ?? "none") : "none";
}

// A status's colour as a Halon token.
export function status_color(state: string | null | undefined): string {
  return state && Object.hasOwn(STATUS_COLORS, state) ? STATUS_COLORS[state as keyof typeof STATUS_COLORS] : color_for(null);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A monitor's status as a badge.
export function StatusBadge({ state }: { state: string }) {
  return <Badge tone={tone_of(state)}>{capitalize(state)}</Badge>;
}

// A value marked with its status: a word becomes a badge, a measured number takes the status colour.
export function StateValue({ text, state }: { text: string; state: string | null }) {
  if (state === null) return <>{text}</>;
  if (state_mark(text) === "color") return <span className={`tone-${tone_of(state)}`}>{text}</span>;
  return <Badge tone={tone_of(state)}>{text}</Badge>;
}

// A dot in a status's colour, such as in the sidebar tree.
export function StatusDot({ state }: { state: string }) {
  return <span className="status-dot" style={{ background: status_color(state) }} aria-hidden="true" />;
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

const REPLY_TONES: Record<ActionReply["tone"], "good" | "bad" | "warn" | "info"> = { positive: "good", negative: "bad", warning: "warn", info: "info" };

// Shows what the server said about an action, poll or toggle.
export function notify(reply: Pick<ActionReply, "notice" | "tone">): void {
  toast(reply.notice, { tone: REPLY_TONES[reply.tone] });
}

// Shows a failed call's reason.
export function notify_error(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), { tone: "bad" });
}

// ── Confirming ───────────────────────────────────────────────────────────────

// Asks the user to confirm `text`, resolving true only on an explicit yes.
export function confirmed(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    open_dialog((close) => (
      <ConfirmDialog
        options={{ title: "Please confirm", message: <p className="pre-wrap">{text}</p>, confirm_label: "Confirm", danger: true, run: async () => { answered = true; resolve(true); } }}
        on_close={() => {
          close();
          if (!answered) resolve(false);
        }}
      />
    ));
  });
}
