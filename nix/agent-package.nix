{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-monitor-agent";
  version = (lib.importJSON ../package.json).version;

  # The agent runs X-Monitor's engine and monitors so it can collect on its own, but never the server or the page.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src/agent
      ../src/core
      ../src/monitors
      ../src/shared
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = import ./npm-deps-hash.nix;

  nativeBuildInputs = [ makeWrapper ];

  # The agent runs its .ts files as they are, so there is nothing to build.
  dontNpmBuild = true;

  # Node will not run .ts files from under a node_modules folder, so the agent lives in lib/x-monitor-agent.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save

    mkdir -p $out/lib/x-monitor-agent/src
    cp -r package.json node_modules $out/lib/x-monitor-agent/
    cp -r src/agent src/core src/monitors src/shared $out/lib/x-monitor-agent/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-monitor-agent \
      --add-flags $out/lib/x-monitor-agent/src/agent/main.ts

    runHook postInstall
  '';

  meta = {
    description = "The X-Monitor agent, which runs commands, watches events and can run its host's monitors for the X-Monitor server";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-monitor-agent";
  };
}
