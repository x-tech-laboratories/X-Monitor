// The x-monitor command: builds the engine from config.yaml, serves the dashboard and API, and runs the engine's loop
// in the same process. `x-monitor token new <name> --scope <scope>` instead mints an API token for auth.tokens and
// exits without starting anything.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { backup_naming, keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { OidcClient, oidc_from_environment } from "@x-tech-laboratories/x-libs/server/oidc";
import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import { parse as parse_yaml } from "yaml";

import { register_plugin_files } from "@x-tech-laboratories/x-libs/server/plugin_files";

import { XMonitorEngine } from "../core/coordination/engine.ts";
import { create_logger_for } from "../core/logging.ts";
import { register_agent_endpoint } from "./agent_endpoint.ts";
import { build_app } from "./app.ts";
import type { ServerEngine } from "./engine_api.ts";
import { ExporterEngine } from "./exporters/index.ts";
import { NotificationEngine } from "./notifications/index.ts";
import { SCOPES, config_snippet, hash_token, new_token } from "./tokens.ts";

const log = create_logger_for("x_monitor.__main__");

// ── Token command ────────────────────────────────────────────────────────────

const token_usage = `usage: x-monitor token new <name> --scope {${SCOPES.join(",")}} [--monitor ID ...]

Mint a token and print the config entry for it.

  <name>          who the token is for, shown in the audit log
  --scope         what the token may do
  --monitor ID    limit a push token to this monitor id; repeat for more (default: every push monitor)`;

// Thrown for a usage mistake, with the exit code argparse gives one.
export class UsageError extends Error {
  readonly code = 2;
}

// Runs `x-monitor token ...`; prints a new token once, with the hash to configure.
export function token_command(argv: string[], print: (text: string) => void = (text) => console.log(text)): number {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args: argv, allowPositionals: true, options: { scope: { type: "string" }, monitor: { type: "string", multiple: true }, help: { type: "boolean", short: "h" } } });
    } catch (error) {
      throw new UsageError(`${(error as Error).message}\n\n${token_usage}`);
    }
  })();
  if (values.help) {
    print(token_usage);
    return 0;
  }
  const [action, name, ...rest] = positionals;
  if (action !== "new" || !name || rest.length > 0) throw new UsageError(token_usage);
  if (!values.scope || !(SCOPES as readonly string[]).includes(values.scope)) throw new UsageError(`--scope must be one of ${SCOPES.join(", ")}\n\n${token_usage}`);
  const monitors = values.monitor ?? [];
  if (monitors.length > 0 && values.scope !== "push") throw new UsageError(`--monitor only applies to --scope push\n\n${token_usage}`);
  const token = new_token();
  print(`Token for ${name} (shown once; X-Monitor keeps only its hash):\n\n  ${token}\n`);
  print("Add this to config.yaml:\n");
  print(config_snippet(name, hash_token(token), values.scope, monitors.length > 0 ? monitors : null));
  return 0;
}

// ── Database path ────────────────────────────────────────────────────────────

// The state database the engine will open: --db, else config.yaml's database.path, else x-monitor.db.
export function database_path(config_path: string, override: string | undefined): string {
  if (override) return override;
  try {
    const config = parse_yaml(readFileSync(config_path, "utf8")) as { database?: { path?: unknown } } | null;
    const path = config?.database?.path;
    if (typeof path === "string" && path) return path;
  } catch {
    // An unreadable config is the engine's to report.
  }
  return "x-monitor.db";
}

// ── Server ───────────────────────────────────────────────────────────────────

export async function serve(argv: string[]): Promise<void> {
  const config = read_server_config<"config" | "db">({
    program: "x-monitor", summary: "X-Monitor: watches hosts and services and serves its dashboard.", env_prefix: "X_MONITOR", default_port: 8080,
    secret: false, argv, web_folder_default: join(import.meta.dirname, "../../dist"),
    built_in: { host: { default: "0.0.0.0" } },
    options: {
      config: { help: "path to config file", placeholder: "<file>", default: "config.yaml" },
      db: { help: "path to the SQLite database file (overrides config)", placeholder: "<file>" },
    },
  });
  const config_path = config.values.config!;
  const db_path = database_path(config_path, config.values.db);

  // A restore picked in Settings waits beside the database and is taken in here, before the engine opens it.
  const restored = take_staged_restore(db_path);
  // The engine builds the notifications and exporters through these, and builds them afresh when a reload changes them.
  const engine = new XMonitorEngine(config_path, {
    db_path_override: config.values.db ?? null,
    handle_signals: true,
    notifications: (db, settings, agents) => new NotificationEngine(db, settings as Record<string, unknown>, agents as never) as never,
    exporters: (db, settings) => {
      const exporters = new ExporterEngine(db, settings as Record<string, unknown>);
      return { start: (monitors) => exporters.start(monitors as never), stop: () => exporters.stop() };
    },
  });
  await engine.setup_modules();
  if (restored) log.info("Restored the state database from the backup picked in Settings");

  // The accounts, sessions and page-made tokens live in the state database beside the engine's own tables.
  const database = new DatabaseSync(db_path);
  database.exec("PRAGMA busy_timeout = 5000");
  const state_folder = dirname(db_path);
  const backups = sqlite_backups({
    folder: () => join(state_folder, "backups"), naming: backup_naming("x-monitor", ".sqlite"),
    database: () => database, database_path: () => db_path,
    // The engine holds the database open, so a restore waits for the next start; systemd starts it again.
    after_staging: () => {
      log.warn("Restarting to restore a backup");
      setTimeout(() => process.exit(75), 500);
    },
  });
  const schedule = json_backup_schedule(join(state_folder, "backup-schedule.json"));
  const automatic_backups = keep_backing_up(backups, schedule.get);

  const oidc_settings = oidc_from_environment("X_MONITOR");
  const accounts_file = process.env.X_MONITOR_PASSWORD_HASH_FILE && existsSync(process.env.X_MONITOR_PASSWORD_HASH_FILE) ? load_accounts("X_MONITOR_PASSWORD_HASH_FILE") : new Map<string, string>();
  const version = (JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as { version: string }).version;
  const server_engine = engine as unknown as ServerEngine;
  const { app } = await build_app({
    engine: server_engine, database, auth_settings: engine.config_loader?.auth_settings ?? {}, accounts_file,
    oidc: oidc_settings === null ? null : new OidcClient(oidc_settings), notifications: () => (engine.notifications instanceof NotificationEngine ? engine.notifications : null),
    backups: { backups, schedule, on_schedule_change: () => void automatic_backups.check() },
    web_folder: config.web_folder, version,
    extra_routes: async (scope) => {
      await register_agent_endpoint(scope, engine.connectors.agents);
      // The page's own plugins, which Settings lists, from the plugins folder beside the config.
      register_plugin_files(scope, { folder: join(dirname(config_path), "plugins"), prefix: "/plugins", side: "web" });
    },
  });

  app.addHook("onClose", async () => {
    automatic_backups.stop();
    await engine.shutdown();
    database.close();
  });
  await app.listen({ host: config.host, port: config.port });
  log.info(`X-Monitor listening on ${config.host}:${config.port}`);
  await engine.run();
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "token") {
    try {
      return token_command(argv.slice(1));
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        return error.code;
      }
      throw error;
    }
  }
  await serve(argv);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
