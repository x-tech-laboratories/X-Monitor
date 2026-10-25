# Moving from Vigil

X-Monitor was called Vigil. Every name changed with it, so an existing install needs these updates:

- The NixOS options are `services.x-monitor` and `services.x-monitor-agent`, and the flake is `github:x-tech-laboratories/X-Monitor`.
- The commands are `x-monitor` and `x-monitor-agent`, and environment variables start with `XMONITOR_`.
- The service users are `x-monitor` and `x-monitor-agent`, and data lives in `/var/lib/x-monitor/x-monitor.db`; move `/var/lib/vigil/vigil.db` there to keep your history.
- The `vigil_self` monitor type is `x_monitor_self`, and the Prometheus metrics are `x_monitor_up` and `x_monitor_metric`.

Agents sign their login with the X-Monitor name, so a Vigil agent cannot log in to an X-Monitor server or the reverse; redeploy every host together.
