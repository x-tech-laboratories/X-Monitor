// Turns the change bus into page refreshes. Every semantic write publishes a change; this tells the open pages once
// per burst rather than once per write: the first change goes out at once, further ones during the cooldown collapse
// into one trailing announcement, and an idle sweep still announces every few seconds because ages ("2m ago", a
// running job's duration) change with no write to say so.

import type { ChangeBus, ChangeKind } from "../../core/state/changes.ts";

// Minimum gap between two announcements.
export const COOLDOWN_SECONDS = 0.5;

// Backstop sweep that redraws values that age on their own.
export const IDLE_REFRESH_SECONDS = 5.0;

export interface ChangeFeed {
  stop(): void;
}

// Announces store changes through `announce` (such as an X-Libs EventStream's announce_change), leading-edge debounced,
// with an idle sweep; `on_change` sees each change as it lands, such as for following a config reload.
export function follow_store_changes(bus: ChangeBus, announce: () => void, options: { cooldown_seconds?: number; idle_seconds?: number; on_change?: (kind: ChangeKind, plugin_id: string | null) => void } = {}): ChangeFeed {
  const cooldown = (options.cooldown_seconds ?? COOLDOWN_SECONDS) * 1000;
  const idle = (options.idle_seconds ?? IDLE_REFRESH_SECONDS) * 1000;
  let cooling: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    pending = false;
    announce();
    cooling = setTimeout(() => {
      cooling = null;
      if (pending) fire();
    }, cooldown);
  };

  const unsubscribe = bus.subscribe((kind, plugin_id) => {
    options.on_change?.(kind, plugin_id);
    if (cooling === null) fire();
    else pending = true;
  });

  const sweep = setInterval(() => {
    if (cooling === null) fire();
  }, idle);
  sweep.unref?.();

  return {
    stop(): void {
      stopped = true;
      unsubscribe();
      clearInterval(sweep);
      if (cooling !== null) clearTimeout(cooling);
    },
  };
}
