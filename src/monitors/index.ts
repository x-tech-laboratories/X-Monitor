// The monitor types X-Monitor ships, by the `type` a config names, each loaded only when a monitor uses it.

import type { PluginClass } from "./base/plugin_base.ts";

export const builtin_monitor_types: Record<string, () => Promise<PluginClass>> = {
  cpu: async () => (await import("./cpu.ts")).Cpu,
};
