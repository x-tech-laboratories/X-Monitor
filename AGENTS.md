# Instructions for AI agents

X-Monitor is a network and system monitor for Linux written in Python, with a NiceGUI dashboard and
an optional agent for monitored hosts. Read `README.md` first; the design is in `docs/develop.md`.

## Setup and checks

- `nix develop` gives the pinned toolchain and puts the repository on `PYTHONPATH`.
- `x-monitor-run` starts the app on <http://localhost:8080> with `config.yaml`.
- Run only the tests for what you changed (`pytest tests/plugins/test_<name>.py`); CI runs the full suite and `ruff check`.

## Rules

- Plugins are pure: they declare requests and parse results, and the engine does all IO. See `docs/develop.md`.
- `x_monitor_agent` must never import from `x_monitor`; a monitored host installs only the agent.
- Secrets reach X-Monitor as file paths or commands read at runtime, never as values in the Nix store.
- Add a test for every behaviour you change, and a failing test first for every bug fix.
- Commit messages follow Conventional Commits and end with an `Assisted-by:` trailer naming the tool.
- Changes reach `main` only through a pull request whose CI passes.
