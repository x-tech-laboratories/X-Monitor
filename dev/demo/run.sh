#!/usr/bin/env bash
# Start the dashboard on the demo fleet: dev/demo/run.sh [port]
# Without a port it takes the first free one from 8099 up, so several sessions can each run one.
set -euo pipefail

demo_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$demo_dir/../.." && pwd)

# ===== Pick a port =====

port_is_free() {
    ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

port=${1:-}
if [ -z "$port" ]; then
    for candidate in $(seq 8099 8199); do
        if port_is_free "$candidate"; then port=$candidate; break; fi
    done
fi
if [ -z "$port" ] || ! port_is_free "$port"; then
    echo "Port ${port:-8099-8199} is taken; pass a free one: $0 <port>" >&2
    exit 1
fi

# ===== Render the config =====

# One state folder per port, on tmpfs, so a restart keeps that demo's history and logging out clears it.
state_dir="${XDG_RUNTIME_DIR:-/tmp}/x-monitor-demo/$port"
mkdir -p "$state_dir"
sed "s/__PORT__/$port/g" "$demo_dir/config.yaml" > "$state_dir/config.yaml"

echo "X-Monitor demo: http://127.0.0.1:$port  (state in $state_dir)"

# ===== Run =====

cd "$repo_root"
command=(python -m x_monitor --config "$state_dir/config.yaml" --db "$state_dir/x-monitor.db" --port "$port")
if [ -n "${IN_NIX_SHELL:-}" ]; then
    exec "${command[@]}"
fi
exec nix develop --command "${command[@]}"
