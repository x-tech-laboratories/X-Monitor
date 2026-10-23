# X-Monitor agent
#
# The companion daemon for a monitored host. It dials outward to the X-Monitor
# server and holds one WebSocket open, carrying both the commands the server
# asks it to run and the events it observes locally.
#
# Nothing listens here: the host opens no port and needs no certificate of its
# own, so this is safe to enable on a machine behind NAT or with a closed
# firewall.
#
# The agent runs unprivileged. Plugins that need root (smartctl, systemctl
# actions) reach it the same way they did over SSH — through scoped NOPASSWD
# sudo rules the deployment grants to `user`. Do not run this as root to avoid
# writing those rules; the rules are the narrower grant.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-monitor-agent;
  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    types
    literalExpression
    ;

  settings = {
    url = cfg.url;
    id = cfg.id;
  }
  // lib.optionalAttrs (cfg.keyFile != null) { key_file = toString cfg.keyFile; }
  // lib.optionalAttrs (cfg.hostname != null) { hostname = cfg.hostname; }
  // cfg.extraSettings;

  # Only the key's *path* reaches this file, so the generated YAML is safe to
  # live in the world-readable Nix store; the agent reads the key at runtime.
  configFile = (pkgs.formats.yaml { }).generate "x-monitor-agent.yaml" settings;

  desktopConfigFile = (pkgs.formats.yaml { }).generate "x-monitor-agent-desktop.yaml" (
    {
      url = cfg.url;
      id = cfg.desktop.id;
      notify_only = true;
    }
    // lib.optionalAttrs (cfg.desktop.keyFile != null) {
      key_file = toString cfg.desktop.keyFile;
    }
  );

in
{
  options.services.x-monitor-agent = {
    enable = mkEnableOption "X-Monitor agent";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.agent;
      defaultText = literalExpression "x-monitor-agent (from flake)";
      description = ''
        The package providing the `x-monitor-agent` binary. Defaults to the
        standalone agent package, which carries only what the agent imports —
        deliberately not the server package, so a monitored host never builds
        nicegui, peewee, dnspython or asyncssh to run an agent.
      '';
    };

    url = mkOption {
      type = types.str;
      example = "ws://x-monitor.example.com:8080/api/agent/ws";
      description = ''
        The X-Monitor server's agent endpoint. Use `wss://` when the dashboard is
        behind TLS. This is an outbound connection, so only egress to the
        server's dashboard port is required.
      '';
    };

    id = mkOption {
      type = types.str;
      example = "web-01";
      description = ''
        This agent's identity. Must match an `id` in the server's `agents:`
        list, and is what a monitor's `agent:` key refers to.
      '';
    };

    keyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_agent_key";
      description = ''
        Path to this agent's unencrypted OpenSSH ed25519 private key, as
        `ssh-keygen -t ed25519 -N ""` writes it. The server's `agents:` entry
        for this `id` holds the matching `public_key`. The agent reads it at
        runtime, so the key never enters the Nix store — point this at a
        sops-nix/agenix-managed secret readable by <option>user</option>.
      '';
    };

    hostname = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Hostname reported to the server, shown in its logs. Defaults to the
        machine's own hostname.
      '';
    };

    user = mkOption {
      type = types.str;
      default = "x-monitor-agent";
      description = ''
        User the agent runs as, and therefore the user every command the server
        sends executes as. Grant it the group memberships and scoped sudo rules
        the monitors on this host need.
      '';
    };

    group = mkOption {
      type = types.str;
      default = "x-monitor-agent";
      description = "Group the agent runs as.";
    };

    extraGroups = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "systemd-journal" ];
      description = ''
        Supplementary groups for <option>user</option>. `systemd-journal` is
        needed for the journal watcher and for any monitor that reads a unit's
        logs.
      '';
    };

    path = mkOption {
      type = types.listOf (types.either types.package types.str);
      default = [ ];
      example = literalExpression ''[ pkgs.smartmontools "/run/current-system/sw" ]'';
      description = ''
        Extra entries on the agent's PATH. The commands monitors send are plain
        shell, so anything they invoke must be resolvable here.

        Strings are allowed so a deployment can pass
        `"/run/current-system/sw"`, giving the agent the same PATH an SSH login
        to this host would have seen — the closest match to the agentless
        behaviour when migrating existing monitors. Entries here precede the
        module's own tools, so they win over its systemd and coreutils. Pass
        the prefix, not its bin/: systemd appends /bin and /sbin to each entry.
      '';
    };

    extraSettings = mkOption {
      type = (pkgs.formats.yaml { }).type;
      default = { };
      description = "Additional keys merged into the generated agent config.";
    };

    desktop = {
      enable = mkEnableOption ''
        a second, notify-only agent in each user's graphical session, to show
        X-Monitor's desktop notifications. The system agent cannot: it runs as its
        own user and has no access to a desktop session. This one runs no
        commands, so it gives the server no access to the user's account
      '';

      id = mkOption {
        type = types.str;
        example = "laptop-desktop";
        description = ''
          This agent's identity, separate from the system agent's `id`. Must
          match an `id` in the server's `agents:` list, and is what a desktop
          notification channel's `agent:` refers to.
        '';
      };

      keyFile = mkOption {
        type = types.path;
        example = "/run/secrets/x_monitor_agent_desktop_key";
        description = ''
          Path to this agent's ed25519 private key, separate from the system
          agent's. It runs as the logged-in user, so that user must be able to
          read it.
        '';
      };
    };
  };

  config = lib.mkMerge [
    (mkIf cfg.desktop.enable {
      systemd.user.services.x-monitor-agent-desktop = {
        description = "X-Monitor agent (desktop notifications)";
        wantedBy = [ "graphical-session.target" ];
        partOf = [ "graphical-session.target" ];
        after = [ "graphical-session.target" ];

        # notify-send shows the notification and xdg-open follows its link. The
        # user's own profile stays on PATH so xdg-open finds their browser; %u is
        # a systemd specifier for the user's name.
        environment.PATH = lib.mkForce (
          lib.concatStringsSep ":" [
            (lib.makeBinPath [
              pkgs.libnotify
              pkgs.xdg-utils
            ])
            "/run/wrappers/bin"
            "/etc/profiles/per-user/%u/bin"
            "/run/current-system/sw/bin"
          ]
        );

        serviceConfig = {
          ExecStart = "${cfg.package}/bin/x-monitor-agent --config ${desktopConfigFile}";
          Restart = "always";
          RestartSec = "10s";
        };
      };
    })
    (mkIf cfg.enable {
      assertions = [
        {
          assertion = cfg.keyFile != null || cfg.extraSettings ? key_file;
          message = ''
            services.x-monitor-agent: set keyFile. Without a key the agent cannot
            authenticate and the server will refuse every connection.
          '';
        }
      ];

      systemd.services.x-monitor-agent = {
        description = "X-Monitor agent (monitored-host companion)";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];

        # The agent runs whatever shell the server sends, so the tools those
        # commands invoke must be on PATH. systemd and coreutils cover the common
        # monitors; anything else comes from `path`, which sits ahead of them so
        # a deployment's own system profile is what a command resolves to. That
        # order matters for sudo: it matches the resolved path, so a `systemctl`
        # taken from this module's systemd would never match a rule written for
        # /run/current-system/sw/bin/systemctl.
        #
        # /run/wrappers comes first and is not optional: NixOS's setuid binaries
        # live in its bin/, and the plain `sudo` in the system profile is not
        # setuid. Without this, every monitor that runs `sudo` (smartctl, borg,
        # systemctl actions) fails with "must be owned by uid 0 and have the
        # setuid bit set" — a shell over SSH picked this up from the login
        # profile, but a systemd unit's PATH does not.
        #
        # Note the value is the prefix, not the bin/ directory: systemd.services
        # .<name>.path appends /bin and /sbin to each entry, so "/run/wrappers/bin"
        # would yield the non-existent /run/wrappers/bin/bin and silently leave
        # the non-setuid sudo first on PATH.
        path = [
          "/run/wrappers"
        ]
        ++ cfg.path
        ++ [
          pkgs.coreutils
          pkgs.systemd
          pkgs.procps
          pkgs.util-linux
          pkgs.gnugrep
          pkgs.gnused
          pkgs.gawk
          pkgs.bash
        ];

        serviceConfig = {
          ExecStart = "${cfg.package}/bin/x-monitor-agent --config ${configFile}";
          User = cfg.user;
          Group = cfg.group;

          # The server restarts, the network flaps, the agent redials on its own
          # with backoff; Restart here only covers the agent itself dying.
          Restart = "always";
          RestartSec = "10s";

          # Detached jobs (a backup, a `nixos-rebuild switch`) live in this unit's
          # cgroup. Killing only the main process on stop/restart lets them run to
          # completion — otherwise a switch that restarts the agent kills itself
          # mid-activation.
          KillMode = "process";

          # Deliberately mild hardening. The agent's whole job is to run the
          # commands the server sends, so sandboxing it away from the system it
          # monitors would defeat the point — ProtectSystem="strict" would hide
          # the very paths disk and filesystem monitors read. Confinement comes
          # from running unprivileged with narrow sudo rules, not from here.
          NoNewPrivileges = false; # sudo rules for smartctl/systemctl need this
          PrivateTmp = true;
          ProtectHome = true;
          RestrictRealtime = true;
          LockPersonality = true;
        };
      };

      users.users.${cfg.user} = lib.mkIf (cfg.user == "x-monitor-agent") {
        isSystemUser = true;
        group = cfg.group;
        description = "X-Monitor agent service user";
        extraGroups = cfg.extraGroups;
        # Commands arrive as shell strings and are run through a shell, so this
        # account needs a real one.
        shell = pkgs.bashInteractive;
      };

      users.groups.${cfg.group} = lib.mkIf (cfg.group == "x-monitor-agent") { };
    })
  ];
}
