{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24 # Runs the server's .ts files directly and builds the web page.
    git
    iputils # ping, for the ICMP connector's tests.
    openssh # ssh-keygen, for the agent key tests.
  ];
}
