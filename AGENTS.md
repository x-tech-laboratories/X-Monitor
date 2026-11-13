# Instructions for AI agents

X-Monitor is a network and system monitor for Linux written in TypeScript: a Fastify server, a React page on X-Libs
and Halon, and an optional agent for monitored hosts. Read `README.md` first; the design is in `docs/develop.md`.

## Setup and checks

- `nix develop` (or `nix-shell`) gives Node 24 and the tools the tests need; then `npm ci`.
- `npm run dev:server` starts the server against `config.example.json`; `npm run dev:web` serves the page with hot reload.
- `dev/demo/run.sh` starts the dashboard on a self-contained demo fleet, on its own free port, and `dev/demo/shoot.sh` screenshots it; use them to check a UI change. See `dev/demo/README.md`.
- Run only the tests for what you changed (`npx vitest run tests/monitors/<name>.test.ts`), plus `npx tsc -p tsconfig.server.json --noEmit` or `tsconfig.web.json` and `npx oxlint <paths>`; CI runs `npm run build`, `npm test` and `npm run lint` in full.

## Rules

- Plugins are pure: they declare requests and parse results, and the engine does all IO. A plugin's page is data (`UI_SPEC`, `custom_view()`), drawn by the page. See `docs/develop.md`.
- The agent carries `src/core` and `src/monitors` but never the server or the page: nothing under `src/agent`, `src/core` or `src/monitors` may import `src/server`, `src/web`, React or Fastify (`tests/agent/imports.test.ts`).
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
