import { describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CmdResult, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { ServiceList } from "../../src/monitors/service_list.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "service-browser", id: "service-browser", interval: 60, ssh_config: { host: "test.host" } };

const service_list_output = `
nginx.service loaded active running Nginx HTTP Server
ssh.service loaded active running OpenSSH Daemon
avahi-daemon.service loaded inactive dead Avahi mDNS/DNS-SD Stack
`;

const unit_file_output = `
nginx.service enabled
ssh.service enabled
avahi-daemon.service disabled
`;

const service_list = (extra: PluginConfig = {}): ServiceList => make_plugin(ServiceList, { ...config, ...extra });
const latest_metric = (plugin: ServiceList, name: string) => store_of(plugin).latest_metric("service-browser", name)?.value ?? null;
const columns_of = (plugin: ServiceList) => Object.fromEntries(plugin.UI_SPEC.tables!.table.columns!.map((column) => [column.name, column]));

describe("service list", () => {
  it("collects services and metrics", () => {
    const plugin = service_list();
    const outputs: CmdResult[] = [cmd_result(0, service_list_output, ""), cmd_result(0, unit_file_output, "")];
    const result = run_cycle(plugin, () => outputs.shift()!);
    expect(latest_metric(plugin, "services_total")).toBeCloseTo(3.0);
    expect(latest_metric(plugin, "services_active")).toBeCloseTo(2.0);
    expect(latest_metric(plugin, "services_failed")).toBeCloseTo(0.0);
    expect((result.snapshot as { enabled: string }[])[2].enabled).toBe("disabled");
    expect(plugin.service_count_text).toBe("3");
  });

  it("calls a failed collection unavailable", () => {
    expect(run_cycle(service_list(), () => cmd_result(-1, "", "not connected")).status).toBe("unavailable");
  });

  it("starts a service", () => {
    const plugin = service_list();
    expect((plugin.plan_action("start_service", { service_name: "nginx.service" }) as ActionPlan).command).toBe("sudo systemctl start nginx.service");
    expect(plugin.interpret_action("start_service", cmd_result(0, "", ""))).toBe(true);
  });

  it("reports a failed systemctl action", () => {
    const outcome = service_list().interpret_action("stop_service", cmd_result(1, "", "denied"), { service_name: "nginx.service" }) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toBe("systemctl stop failed for nginx.service: denied");
  });

  it("refuses view_status without a service", () => expect((service_list().plan_action("view_status") as CollectResult).success).toBe(false));

  it("plans the status command", () => {
    expect((service_list().plan_action("view_status", { service_name: "nginx.service" }) as ActionPlan).command).toBe("sudo systemctl status nginx.service --no-pager");
  });

  it("returns the status output as content", () => {
    const outcome = service_list().interpret_action("view_status", cmd_result(0, "Active: active", "")) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.metadata).toEqual({ content: "Active: active" });
  });

  it("plans the cat command for a unit file", () => {
    expect((service_list().plan_action("view_unit_file", { service_name: "nginx.service" }) as ActionPlan).command).toBe("sudo systemctl cat nginx.service");
  });

  it("resolves the path and writes the unit file through base64", () => {
    const plan = service_list().plan_action("write_unit_file", { service_name: "nginx.service", content: "[Unit]\n" }) as ActionPlan;
    expect(plan.command).toContain("systemctl show -p FragmentPath");
    expect(plan.command).toContain(Buffer.from("[Unit]\n").toString("base64"));
    expect(plan.command).toContain(`"$P" = /etc/systemd/system || case "$P" in /etc/systemd/system/*) true;; *) false;; esac`);
  });

  it("plans nothing for an unknown action", () => expect(service_list().plan_action("nuke_service", { service_name: "nginx.service" })).toBeNull());

  it("makes the active and enabled cells switches", () => {
    const columns = columns_of(service_list());
    expect(columns.active.toggle!.on_action_id).toBe("start_service");
    expect(columns.active.toggle!.off_action_id).toBe("stop_service");
    expect(columns.enabled.toggle!.on_action_id).toBe("enable_service");
    expect(columns.enabled.toggle!.off_action_id).toBe("disable_service");
  });

  it("keeps reload daemon a header action only", () => {
    const plugin = service_list();
    expect(plugin.get_actions().map((action) => action.action_id)).toEqual(["daemon_reload"]);
    expect("buttons" in plugin.UI_SPEC).toBe(false);
  });

  it("titles the services table", () => expect((service_list().UI_SPEC.tables!.table as { title?: string }).title).toBe("Services"));

  it("does not repeat switched actions as row buttons", () => {
    const ids = new Set(service_list().UI_SPEC.tables!.table.row_actions!.map((action) => action.id));
    for (const id of ["start_service", "stop_service", "enable_service", "disable_service"]) expect(ids.has(id)).toBe(false);
    expect(ids.has("restart_service")).toBe(true);
  });

  it("returns the reload action", () => expect(service_list().get_actions().map((action) => action.action_id)).toContain("daemon_reload"));

  it("shows the edit button only when editing is allowed", () => {
    const edit = (plugin: ServiceList) => plugin.UI_SPEC.tables!.table.row_actions!.find((action) => action.id === "edit_file")!;
    const visible = (plugin: ServiceList) => (edit(plugin).visible_if as (plugin: unknown) => boolean)(plugin);
    expect(visible(service_list())).toBe(false);
    expect(visible(service_list({ allow_unit_file_edit: true }))).toBe(true);
  });
});
