{
    description = "A lightweight, pluggable network and system monitor for Linux";

    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
        flake-utils.url = "github:numtide/flake-utils";
    };

    outputs =
        {
            self,
            nixpkgs,
            flake-utils,
        }:
        flake-utils.lib.eachDefaultSystem (
            system:
            let
                # inline-snapshot 0.32.5 fails its own documentation tests in
                # current nixpkgs and is not cached by Hydra, which breaks the
                # build of anything pulling it in as a check dependency (pydantic
                # → FastAPI → NiceGUI, in our case). Disable its test suite so
                # the package builds from source without running those tests.
                inlineSnapshotFix = final: prev: {
                    python312 = prev.python312.override {
                        packageOverrides = pyfinal: pyprev: {
                            inline-snapshot = pyprev.inline-snapshot.overridePythonAttrs (old: {
                                doCheck = false;
                                pytestCheckPhase = "true";
                            });
                            # The overlay moves apprise off the binary cache, and its own test suite takes over 20 minutes to build.
                            apprise = pyprev.apprise.overridePythonAttrs (old: {
                                doCheck = false;
                            });
                            # anyio 4.14.2 fails its own TLS and LRU-cache tests under Python 3.12.
                            anyio = pyprev.anyio.overridePythonAttrs (old: {
                                doCheck = false;
                            });
                            # watchfiles' permission-denied test times out in the build sandbox.
                            watchfiles = pyprev.watchfiles.overridePythonAttrs (old: {
                                doCheck = false;
                            });
                        };
                    };
                    python312Packages = final.python312.pkgs;
                };
                pkgs = import nixpkgs {
                    inherit system;
                    overlays = [ inlineSnapshotFix ];
                };
                pyproject = builtins.fromTOML (builtins.readFile ./pyproject.toml);

                pythonDeps = with pkgs.python312Packages; [
                    # httpx serves the async HTTP connector; requests remains
                    # for the sync InfluxDB push exporter.
                    httpx
                    requests
                    pyyaml
                    peewee
                    nicegui
                    dnspython
                    # Native async SSH transport (see
                    # x_monitor/core/connectors/ssh_connector.py) — the agentless
                    # way of reaching a monitored host.
                    asyncssh
                    # The apprise notification channel (x_monitor/core/notifications/mail.py).
                    apprise
                    # The MQTT exporter (x_monitor/core/exporters/mqtt.py).
                    aiomqtt
                    # The agent transport's client half (x_monitor_agent/client.py).
                    # The server side needs nothing extra: nicegui already
                    # brings FastAPI/uvicorn, which serve the agent WebSocket.
                    websockets
                    # Ed25519 keys for the agent handshake (x_monitor_agent/keys.py).
                    cryptography
                ];

                x-monitor-pkg = pkgs.python312Packages.buildPythonApplication {
                    pname = pyproject.project.name;
                    version = pyproject.project.version;
                    format = "pyproject";
                    src = ./.;

                    nativeBuildInputs = [ pkgs.python312Packages.setuptools ];
                    propagatedBuildInputs = pythonDeps;

                    pythonImportsCheck = [ "x_monitor" ];
                };

                # The agent, packaged apart from the server.
                #
                # A monitored host installs only this, so it must not pull in
                # nicegui, peewee, dnspython or asyncssh — none of which the
                # agent imports, and building them on every target is both
                # wasteful and, on aarch64, a source of build failures the
                # monitored host has no reason to care about.
                #
                # `x_monitor_agent` imports nothing from `x_monitor` (the wire protocol
                # lives in x_monitor_agent/protocol.py precisely so it doesn't), so
                # copying that one package in is the whole install.
                agentPython = pkgs.python312.withPackages (ps: with ps; [
                    websockets
                    pyyaml
                    cryptography
                ]);

                agentSrc = pkgs.runCommand "x-monitor-agent-src" { } ''
                    mkdir -p $out
                    cp -r ${./x_monitor_agent} $out/x_monitor_agent
                '';

                x-monitor-agent-pkg = pkgs.writeShellApplication {
                    name = "x-monitor-agent";
                    text = ''
                        export PYTHONPATH="${agentSrc}''${PYTHONPATH:+:$PYTHONPATH}"
                        exec ${agentPython}/bin/python3 -m x_monitor_agent "$@"
                    '';
                };

                # X-Monitor runs as a single process (target polling and the web
                # dashboard share one asyncio event loop — see
                # x_monitor/__main__.py). This dev script just runs it.
                x-monitor-run = pkgs.writeShellScriptBin "x-monitor-run" ''
                    set -e
                    # Find project root (where pyproject.toml is)
                    XMONITOR_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
                    while [ "$XMONITOR_ROOT" != "/" ] && [ ! -f "$XMONITOR_ROOT/pyproject.toml" ]; do
                        XMONITOR_ROOT=$(dirname "$XMONITOR_ROOT")
                    done

                    export PYTHONPATH="$XMONITOR_ROOT:$PYTHONPATH"

                    echo "Starting X-Monitor on http://localhost:8080"
                    exec python3 -m x_monitor --config "$XMONITOR_ROOT/config.yaml" --port 8080 "$@"
                '';
            in
            {
                packages.default = x-monitor-pkg;
                packages.agent = x-monitor-agent-pkg;

                apps.default = {
                    type = "app";
                    program = "${x-monitor-pkg}/bin/x-monitor";
                };

                devShells.default = pkgs.mkShell {
                    buildInputs = [
                        (pkgs.python312.withPackages (
                            ps:
                            pythonDeps
                            ++ [
                                ps.pip
                                ps.setuptools
                                ps.pytest
                                ps.pytest-asyncio
                            ]
                        ))
                        x-monitor-run
                    ];

                    shellHook = ''
                        # Identify project root and set PYTHONPATH
                        XMONITOR_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
                        export PYTHONPATH="$XMONITOR_ROOT:$PYTHONPATH"

                        echo "X-Monitor development environment loaded."
                        echo "Python: $(python3 --version)"
                        echo ""
                        echo "Commands:"
                        echo "  x-monitor-run              Start the application"
                        echo "  pytest                 Run all tests"
                        echo "  pytest tests/plugins/  Run plugin tests only"
                        echo "  pytest tests/unit/     Run unit tests only"
                        echo "  pytest -v              Verbose test output"
                        echo "  pytest -k <name>       Run tests matching name"
                    '';
                };
            }
        ) // {
            nixosModules.x-monitor = import ./nix/module.nix self;
            nixosModules.default = import ./nix/module.nix self;
            # The monitored-host half. Enabled on every host X-Monitor watches
            # through an agent; the server module above is enabled only on the
            # machine running the dashboard.
            nixosModules.agent = import ./nix/agent-module.nix self;
        };
}
