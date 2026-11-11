#!/usr/bin/env bash
# Start the dashboard on the demo fleet: dev/demo/run.sh [--sample] [port]
# Without a port it takes the first free one from 8099 up, so several sessions can each run one.
# --sample runs the homelab-shaped fleet in sample.yaml on moving sample readings instead.
set -euo pipefail

sample=false
if [ "${1:-}" = "--sample" ]; then
    sample=true
    shift
fi

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
config_source="$demo_dir/config.yaml"
if $sample; then config_source="$demo_dir/sample.yaml"; fi
sed "s/__PORT__/$port/g" "$config_source" > "$state_dir/config.yaml"

echo "X-Monitor demo: http://127.0.0.1:$port  (state in $state_dir)"

# ===== Run =====

cd "$repo_root"
# The page is served built, so build it once when it is missing.
if [ ! -f dist/index.html ]; then npx vite build >/dev/null; fi
entry=src/server/main.ts
if $sample; then entry=dev/demo/sample.ts; fi
exec node "$entry" --config "$state_dir/config.yaml" --db "$state_dir/x-monitor.db" --host 127.0.0.1 --port "$port"
