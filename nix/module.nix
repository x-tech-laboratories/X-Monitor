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

  # Merge in dashboard/API auth when both authUsername and authPasswordFile
  # are set. Only the password *path* is written to the generated YAML (which
  # lands in the Nix store) — X-Monitor reads the file itself at runtime, so the
  # password never enters the store.
  withAuth =
    if cfg.settings != null && cfg.authUsername != null && cfg.authPasswordFile != null then
      cfg.settings
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
      cfg.settings;

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

    authUsername = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "admin";
      description = ''
        An admin's user name, signing in on the dashboard's sign-in page.
        Must be set together with <option>authPasswordFile</option>; if only
        one is set, X-Monitor logs a warning and leaves that account out.
        Further users are added on the Users page, and the accounts file
        (<option>accountsFile</option>) can declare more admins.
      '';
    };

    authPasswordFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_dashboard_password";
      description = ''
        Path to a file on this host containing that admin's password.
        X-Monitor reads it at runtime, so the password never enters the Nix
        store — point this at a sops-nix/agenix-managed secret readable by
        the X-Monitor service user (<option>user</option>).
      '';
    };

    accountsFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_accounts";
      description = ''
        Path to an accounts file of `name:hash` lines, written by
        `npm run hash-password`, whose users are admins the dashboard cannot
        change. Read at runtime, so it never enters the Nix store.
      '';
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_env";
      description = ''
        A file of `X_MONITOR_*` variables for the service, such as the
        single sign-on settings (`X_MONITOR_OIDC_*`), kept out of the Nix store.
      '';
    };

    authSessionSecretFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/x_monitor_session_secret";
      description = ''
        No longer used: sessions are kept in X-Monitor's database, so they
        survive restarts without a signing key. Kept so existing configurations
        still evaluate; X-Monitor logs that it ignores the setting.
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

    # X-Monitor runs as one Node process: the engine's polling and the Fastify server for the dashboard and API share it.
    systemd.services.x-monitor = {
      description = "X-Monitor (network/system monitor + dashboard)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      # ping, for the ICMP connector, must be on PATH; SSH is spoken natively, so no ssh client is needed.
      path = [
        pkgs.iputils
      ];

      # The known_hosts file the SSH connector's trust-on-first-use keeps lives here, since ProtectHome hides ~/.ssh.
      environment = {
        XMONITOR_SSH_CONTROL_DIR = "/tmp/x-monitor-ssh";
      }
      // lib.optionalAttrs (cfg.accountsFile != null) {
        X_MONITOR_PASSWORD_HASH_FILE = toString cfg.accountsFile;
      };

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/x-monitor --config ${configFile} --db ${cfg.dataDir}/x-monitor.db --port ${toString cfg.port}";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.dataDir;
        StateDirectory = "x-monitor";
        StateDirectoryMode = "0750";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        # A restore picked in Settings exits with 75 and is taken in on the next start.
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
