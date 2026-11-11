# Instructions for AI agents

X-Monitor is a network and system monitor for Linux written in Python, with a NiceGUI dashboard and
an optional agent for monitored hosts. Read `README.md` first; the design is in `docs/develop.md`.

## Setup and checks

- `nix develop` gives the pinned toolchain and puts the repository on `PYTHONPATH`.
- `x-monitor-run` starts the app on <http://localhost:8080> with `config.yaml`.
- `dev/demo/run.sh` starts the dashboard on a self-contained demo fleet, on its own free port, and `dev/demo/shoot.sh` screenshots it; use them to check a UI change. See `dev/demo/README.md`.
- Run only the tests for what you changed (`pytest tests/plugins/test_<name>.py`); CI runs the full suite and `ruff check`.

## Rules

- Plugins are pure: they declare requests and parse results, and the engine does all IO. See `docs/develop.md`.
- The agent carries `x_monitor`'s plugins and engine but never the dashboard: nothing it imports may pull in `x_monitor.core.ui`, NiceGUI, FastAPI or the server's notification and export extras (`tests/unit/test_agent_imports.py`).
- Secrets reach X-Monitor as file paths or commands read at runtime, never as values in the Nix store.
- Add a test for every behaviour you change, and a failing test first for every bug fix.
- Commit messages follow Conventional Commits and end with an `Assisted-by:` trailer naming the tool.
- Changes reach `main` only through a pull request whose CI passes.

## X-Tech standards

- Follow the [Application Standard](https://x-tech-laboratories.github.io/standards/application/) and the
  [Design Guidelines](https://x-tech-laboratories.github.io/standards/design/), whose source is `src/content/docs/standards/`
  in [x-tech-laboratories.github.io](https://github.com/x-tech-laboratories/x-tech-laboratories.github.io). Ask before
  changing either, since a change applies to every X-app.
- Use [X-Libs](https://github.com/x-tech-laboratories/X-Libs) and Halon ([X-Themes](https://github.com/x-tech-laboratories/X-Themes))
  before writing your own code: check the module table in the X-Libs README first.
- A feature another app could use belongs in X-Libs, or Halon for styling, with tests and a README row. If that is out
  of reach, add it to the candidates in X-Libs' `docs/TODO.md`.
