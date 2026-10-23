#!/usr/bin/env bash
# Screenshot a running demo: dev/demo/shoot.sh --port 8099 --out /some/dir [page ...]
# Builds a Python with Playwright and its browsers from nixpkgs on first use; later runs reuse the store paths.
set -euo pipefail

demo_dir=$(cd "$(dirname "$0")" && pwd)

python_env=$(nix build --no-link --print-out-paths --impure --expr \
    'with import (builtins.getFlake "nixpkgs") {}; python3.withPackages (p: [ p.playwright ])')
browsers=$(nix build --no-link --print-out-paths 'nixpkgs#playwright-driver.browsers')

PLAYWRIGHT_BROWSERS_PATH="$browsers" exec "$python_env/bin/python" -I "$demo_dir/shoot.py" "$@"
