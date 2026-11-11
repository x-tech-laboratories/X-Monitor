// The page: the sign-in, the shell around every view (top bar, the sidebar's views and monitor tree, theme), the
// server's change feed and the router between views.

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./widgets/widgets.css";
import "./app.css";
import { follow_changes } from "@x-tech-laboratories/x-libs/web/events";
import { AccountView, UsersView } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { Shell, use_route } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { link, type Route } from "@x-tech-laboratories/x-libs/web/router";
import type { Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";
import { Fragment, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { accounts, calls, changes, CHANGES_PATH, live } from "./api.ts";
import { plugin_host, start_plugins } from "./plugins.ts";
import { LogsView } from "./views/logs.tsx";
import { MonitorView } from "./views/monitor.tsx";
import { OverviewView } from "./views/overview.tsx";
import { EventsView, open_notifications, SchedulesView, SettingsView, SystemMenu } from "./views/side_views.tsx";
import { MonitorTree } from "./views/sidebar.tsx";

const theme = theme_choice("x-monitor-theme");

const role_text = { viewer: "Reads everything; changes nothing.", admin: "Also runs actions, polls and manages users." };

// ── Routing ──────────────────────────────────────────────────────────────────

interface View {
  title: string;
  // The sidebar entry to light up.
  section: string;
  monitor_id: string | null;
  view: ReactNode;
}

// The fixed views in the sidebar, in its order.
export const SIDEBAR_VIEWS: [section: string, label: string][] = [["", "All Monitors"], ["events", "Events"], ["schedules", "Schedules"], ["logs", "Logs"], ["settings", "Settings"]];

export function view_for({ parts }: Route, me: Me): View {
  const [section = "", id] = parts;
  if (section === "monitor" && id) return { title: id, section: "monitor", monitor_id: id, view: <MonitorView id={id} /> };
  if (section === "events") return { title: "Events", section, monitor_id: null, view: <EventsView /> };
  if (section === "schedules") return { title: "Schedules", section, monitor_id: null, view: <SchedulesView /> };
  if (section === "logs") return { title: "Logs", section, monitor_id: null, view: <LogsView /> };
  if (section === "settings") return { title: "Settings", section, monitor_id: null, view: <SettingsView plugins={plugin_host} /> };
  if (section === "account") return { title: "Your account", section, monitor_id: null, view: <AccountView client={accounts} role_text={role_text} /> };
  if (section === "users" && me.role === "admin") return { title: "Users", section, monitor_id: null, view: <UsersView client={accounts} me={me} role_text={role_text} /> };
  return { title: "All Monitors", section: "", monitor_id: null, view: <OverviewView /> };
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ active, monitor_id, me }: { active: string; monitor_id: string | null; me: Me }) {
  const sidebar = use_resource(() => calls.sidebar(), [], live);
  const views = me.role === "admin" ? [...SIDEBAR_VIEWS, ["users", "Users"] as [string, string]] : SIDEBAR_VIEWS;
  return (
    <>
      <nav className="sidebar-views" aria-label="Views">
        {views.map(([section, label]) => (
          <a key={section} href={link(section ? [section] : [])} className={section === active ? "active" : undefined} aria-current={section === active ? "page" : undefined}>{label}</a>
        ))}
      </nav>
      {sidebar.data && (
        <MonitorTree
          nodes={sidebar.data.nodes}
          settings={sidebar.data.settings}
          monitor_id={monitor_id}
          on_settings={(changes_made) => void calls.save_sidebar(changes_made).catch(() => undefined)}
        />
      )}
    </>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { account, refresh, sign_out } = use_account(accounts);
  const route = use_route();
  const me = account.state === "signed_in" ? account.me : null;
  const logged_in = me !== null;

  // The change feed needs a session, so it opens on signing in and closes on signing out.
  useEffect(() => {
    if (!logged_in) return;
    const feed = follow_changes(CHANGES_PATH, { watch: changes });
    void start_plugins();
    return () => feed.close();
  }, [logged_in]);

  const shown = me ? view_for(route, me) : null;
  const view_key = `${route.parts.join("/")}?${route.query}`;
  const sidebar_width = use_resource(() => calls.sidebar(), [], { enabled: logged_in });

  useEffect(() => {
    if (shown) document.title = `${shown.title} · X-Monitor`;
  }, [shown?.title, logged_in]);

  return (
    <Shell
      key={logged_in ? "open" : "closed"}
      brand="X-Monitor"
      brand_icon="/icon.svg"
      theme={theme}
      user={me?.name ?? null}
      user_href="#/account"
      on_logout={() => void sign_out()}
      view_key={view_key}
      sidebar={me && shown ? <Sidebar active={shown.section} monitor_id={shown.monitor_id} me={me} /> : undefined}
      sidebar_width={{ default_width: sidebar_width.data?.settings.drawer_width ?? 248, min: 200, max: 600, on_change: (width, done) => { if (done) void calls.save_sidebar({ drawer_width: width }).catch(() => undefined); } }}
      tools={<><button type="button" onClick={open_notifications}>Notifications</button><SystemMenu /></>}
    >
      {account.state === "signed_out" && <SignInForm client={accounts} title="X-Monitor" icon="/icon.svg" on_signed_in={refresh} />}
      {/* A new address draws its view afresh, as each view loads what it shows when it starts. */}
      {shown && <Fragment key={view_key}>{shown.view}</Fragment>}
    </Shell>
  );
}

const root = document.getElementById("app");
if (root) createRoot(root).render(<App />);
