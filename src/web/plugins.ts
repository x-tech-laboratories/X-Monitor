// The page's plugin host: plugins the server lists under /plugins, each on or off and with its settings kept in this
// browser, shown in Settings.

import { create_plugin_host, json_plugin_storage, type PluginHost } from "@x-tech-laboratories/x-libs/plugins";
import { load_plugin_modules, share_modules } from "@x-tech-laboratories/x-libs/web/plugin_imports";
import * as React from "react";
import * as jsx_runtime from "react/jsx-runtime";

const STORAGE_KEY = "x-monitor.plugins";

function browser_storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = browser_storage();

export const plugin_host: PluginHost = create_plugin_host({
  app: { id: "x-monitor", version: "0.2.0" },
  storage: storage ? json_plugin_storage({ get: () => storage.getItem(STORAGE_KEY), set: (text) => storage.setItem(STORAGE_KEY, text) }) : undefined,
  on_error: (plugin_id, error) => console.warn(`plugin ${plugin_id}:`, error),
});

// Loads the plugins the server offers and starts those that are on; a server with none offers an empty list.
export async function start_plugins(): Promise<void> {
  share_modules({ react: React, "react/jsx-runtime": jsx_runtime });
  try {
    const loaded = await load_plugin_modules("plugins/index.json");
    for (const plugin of loaded.plugins) await plugin_host.add(plugin);
    for (const problem of loaded.problems) console.warn(`plugin ${problem.name}: ${problem.problem}`);
  } catch {
    // No plugins folder is served, so there is nothing to add.
  }
  await plugin_host.start();
}
