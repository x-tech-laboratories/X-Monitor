{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-monitor";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.server.json
      ../tsconfig.web.json
      ../vite.config.ts
      ../resources
      ../src
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = import ./npm-deps-hash.nix;

  nativeBuildInputs = [ makeWrapper ];

  # The build typechecks every target, so its tests are not needed here; vite writes the page to dist.
  npmBuildScript = "build";

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/x-monitor.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save

    mkdir -p $out/lib/x-monitor/src
    cp -r package.json dist node_modules $out/lib/x-monitor/
    cp -r src/server src/agent src/core src/monitors src/shared $out/lib/x-monitor/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-monitor \
      --add-flags $out/lib/x-monitor/src/server/main.ts \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "A web-based network and systems monitor for Linux hosts, homelabs and small networks";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-monitor";
  };
}
