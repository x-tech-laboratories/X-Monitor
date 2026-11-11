{
  description = "X-Monitor — a web-based network and systems monitor for Linux hosts, homelabs and small networks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        x-monitor = pkgs.callPackage ./nix/package.nix { };
      in
      {
        packages.default = x-monitor;
        # The agent, packaged apart from the server so a monitored host never carries the server or the page.
        packages.agent = pkgs.callPackage ./nix/agent-package.nix { };

        apps.default = {
          type = "app";
          program = "${x-monitor}/bin/x-monitor";
        };

        devShells.default = import ./shell.nix { inherit pkgs; };
      }
    ) // {
      nixosModules.x-monitor = import ./nix/module.nix self;
      nixosModules.default = import ./nix/module.nix self;
      # The monitored-host half, enabled on every host X-Monitor watches through an agent.
      nixosModules.agent = import ./nix/agent-module.nix self;
    };
}
