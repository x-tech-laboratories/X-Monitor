self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-monitor;
  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    types
    literalExpression
    ;

  # Recursively inject the default borg passphrase_file into every `borg`
  # monitor that doesn't already set one, walking the nested plugin tree
  # (borg monitors usually live under group `children`). The file is read by
  # X-Monitor at runtime on this host, so the secret never enters the Nix store.
  injectBorgPassphrase =
    plugins:
    map (
      p:
      let
        withChildren =
          if p ? children then p // { children = injectBorgPassphrase p.children; } else p;
      in
      if (p.type or null) == "borg" && !(p ? passphrase_file) && !(p ? passphrase) then
        withChildren // { passphrase_file = cfg.borgPassphraseFile; }
      else
        withChildren
    ) plugins;

  # A view can define monitors of its own, so its tree gets the same injection.
  withBorgPassphrase =
    if cfg.settings != null && cfg.borgPassphraseFile != null then
      cfg.settings
      // lib.optionalAttrs (cfg.settings ? plugins) {
        plugins = injectBorgPassphrase cfg.settings.plugins;
      }
      // lib.optionalAttrs (cfg.settings ? views) {
        views = map (
          v: if v ? plugins then v // { plugins = injectBorgPassphrase v.plugins; } else v
        ) cfg.settings.views;
      }
    else
      cfg.settings;

  # Merge in dashboard/API auth when both authUsername and authPasswordFile
  # are set. Only the password *path* is written to the generated YAML (which
  # lands in the Nix store) — X-Monitor reads the file itself at runtime, so the
  # password never enters the store.
  withAuth =
    if withBorgPassphrase != null && cfg.authUsername != null && cfg.authPasswordFile != null then
      withBorgPassphrase
      // {
        auth =
          (cfg.settings.auth or { })
          // {
            username = cfg.authUsername;
            password_file = cfg.authPasswordFile;
          }
          // lib.optionalAttrs (cfg.authSessionSecretFile != null) {
            session_secret_file = cfg.authSessionSecretFile;
          };
      }
    else
      withBorgPassphrase;

  finalSettings = withAuth;

  configFile =
    if cfg.configFile != null then
      cfg.configFile
    else if finalSettings != null then
      (pkgs.formats.yaml { }).generate "x-monitor.yaml" finalSettings
    else
      throw "services.x-monitor: either configFile or settings must be set";

in
{
  options.services.x-monitor = {
    enable = mkEnableOption "X-Monitor system monitor";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = literalExpression "x-monitor (from flake)";
      description = "The X-Monitor package to use.";
    };

    configFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = literalExpression "./x-monitor.yaml";
      description = ''
        Path to a pre-written X-Monitor config.yaml.
        Mutually exclusive with <option>services.x-monitor.settings</option>.
      '';
    };

    settings = mkOption {
      type = types.nullOr (pkgs.formats.yaml { }).type;
      default = null;
      example = literalExpression ''
        {
          plugins = [
            {
              name = "My Server";
              type = "uptime";
              target_host = "server.example.com";
            }
          ];
        }
      '';
      description = ''
        X-Monitor configuration as a Nix attribute set, serialized to YAML and
        passed to the service. Mutually exclusive with
        <option>services.x-monitor.configFile</option>.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port for the web dashboard.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/x-monitor";
      description = "Directory for persistent data (SQLite database).";
    };

    user = mkOption {
      type = types.str;
      default = "x-monitor";
      description = "User account under which X-Monitor runs.";
    };

    group = mkOption {
      type = types.str;
      default = "x-monitor";
      description = "Group under which X-Monitor runs.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the dashboard port in the firewall.";
    };

    borgPassphraseFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/borg_laptop_passphrase";
      description = ''
        Path to a file on this host containing the passphrase for encrypted
        borg repositories. Injected as `passphrase_file` into every `borg`
        monitor in <option>settings</option> that does not set its own
        `passphrase_file` or `passphrase`.

        X-Monitor reads the file at runtime and passes the passphrase to the remote
        borg command, so the secret lives only on the machine X-Monitor runs on —
        the monitored hosts need no copy. Point this at a
        sops-nix/agenix-managed secret readable by the X-Monitor service user; the
        value never enters the Nix store.
      '';
    };

    authUsername = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "admin";
      description = ''
        Username required for HTTP Basic Auth on the dashboard and REST API.
        Must be set together with <option>authPasswordFile</option> to enable
        auth; if only one is set, X-Monitor logs a warning and leaves the
        dashboard/API unauthenticated.
      '';
    };

    authPasswordFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_dashboard_password";
      description = ''
        Path to a file on this host containing the HTTP Basic Auth password.
        X-Monitor reads it at runtime, so the password never enters the Nix
        store — point this at a sops-nix/agenix-managed secret readable by
        the X-Monitor service user (<option>user</option>).
      '';
    };

    authSessionSecretFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_session_secret";
      description = ''
        Path to a file holding the key that signs dashboard session cookies.
        Without it X-Monitor generates a key at every start, so a restart signs
        every browser out; with it, sessions survive restarts and redeploys.
        Any random string of 32 or more bytes will do. Read at runtime, so it
        never enters the Nix store.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = !(cfg.configFile != null && cfg.settings != null);
        message = "services.x-monitor: configFile and settings are mutually exclusive — set only one.";
      }
    ];

    # X-Monitor runs as a single process (see x_monitor/__main__.py): one
    # asyncio event loop owns both the target-polling schedule and the
    # NiceGUI web dashboard, sharing the SQLite database directly in-process
    # rather than over a loopback API.
    systemd.services.x-monitor = {
      description = "X-Monitor (network/system monitor + dashboard)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      # ping (uptime plugin, run as a local subprocess) must be on PATH.
      # The system `ssh` client is NOT needed here — X-Monitor speaks SSH
      # natively via asyncssh (see core/connectors/ssh.py) rather
      # than shelling out.
      path = [
        pkgs.iputils
      ];

      # The known_hosts file X-Monitor's own TOFU host-key trust persists to
      # (see ssh.py's _TofuClient) lives here — writable, and
      # ProtectHome hides ~/.ssh. Under the service's private /tmp.
      environment.XMONITOR_SSH_CONTROL_DIR = "/tmp/x-monitor-ssh";

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/x-monitor --config ${configFile} --db ${cfg.dataDir}/x-monitor.db --port ${toString cfg.port}";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.dataDir;
        StateDirectory = "x-monitor";
        StateDirectoryMode = "0750";
        Restart = "on-failure";
        RestartSec = "5s";

        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        # ping needs CAP_NET_RAW to open its ICMP socket; grant just that one
        # (ambient so the unprivileged service process actually receives it).
        CapabilityBoundingSet = [ "CAP_NET_RAW" ];
        AmbientCapabilities = [ "CAP_NET_RAW" ];
        LockPersonality = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallFilter = [ "@system-service" ];
      };
    };

    users.users.x-monitor = lib.mkIf (cfg.user == "x-monitor") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
      description = "X-Monitor service user";
    };

    users.groups.x-monitor = lib.mkIf (cfg.group == "x-monitor") { };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
