# Demo fleet

A small, self-contained fleet for seeing a dashboard change in a real browser. It needs no hosts:
the checks run against this machine, and every monitor state shows up within a minute.

| Monitor | Checks | Shows as |
| --- | --- | --- |
| Dashboard Self | HTTP against the demo itself | online, with a latency chart |
| Dead Endpoint | HTTP against a closed port | failed |
| Loopback Ping | ICMP to 127.0.0.1 | online |
| CPU, Nginx | SSH to a closed port | unavailable |

A webhook channel pointed at a closed port gives the Notifications dialog something to list.

## Run it

```bash
dev/demo/run.sh          # first free port from 8099 up
dev/demo/run.sh 8123     # a port of your choosing
```

Run it from your own worktree to see your own code. Each port keeps its database under
`$XDG_RUNTIME_DIR/x-monitor-demo/<port>/`, so a restart keeps the charts' history; delete that
folder for a clean start.

## Sample data

```bash
dev/demo/run.sh --sample          # a homelab-shaped fleet on moving sample readings
dev/demo/run.sh --sample 8123
```

`--sample` runs `sample.yaml`, a fleet of four hosts, IoT sensors, backups, NixOS deployments and
vulnerability scans, on `sample.py`. That is the real dashboard on an engine whose cycles apply a
sample reading for each monitor's type instead of collecting, so every chart, gauge, strip and
fleet section has live data and nothing is contacted. A type with no sample in `sample.py` shows as
unavailable.

## Screenshot it

```bash
dev/demo/shoot.sh --port 8123 --out /tmp/shots              # every page, light and dark
dev/demo/shoot.sh --port 8123 --schemes dark overview http  # some pages, one scheme
```

The pages are `overview`, `events`, `schedules`, `group`, `http` and `systemd`; any other argument is taken as
a path. The first run builds Playwright and its browsers from nixpkgs.

Stop the demo with Ctrl+C, or `pkill -f "x-monitor-demo/<port>"` when it runs in the background.
