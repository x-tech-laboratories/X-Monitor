# Theme

The dashboard is themed with **Halon**: slate plus a single blue, a recessed
navigation frame, ghost-first controls and hairline structure, in a light and a
dark scheme that share one token set. Every color lives in
`x_monitor/core/ui/static/halon-tokens.css`; the component rules that consume those
tokens live beside it in `halon.css`, and no Python module states a color.

The scheme follows the browser's `prefers-color-scheme` unless you pin it:

```yaml
theme:
  scheme: dark      # auto (default), light, or dark
```

## Token overrides

Individual tokens can be overridden from the same `theme:` block. Each key maps to one
token and applies to **both** schemes, so an override that only suits one of
them is yours to audit — the shipped values are contrast-audited in both.

| Field              | Token                   | Role                                     |
|--------------------|-------------------------|------------------------------------------|
| `scheme`           | —                       | `auto`, `light`, or `dark`                |
| `primary`          | `--accent`              | Links, focus, the one filled button       |
| `background`       | `--surface-default`     | Cards and panels                          |
| `background_muted` | `--surface-root`        | The page behind them                      |
| `text`             | `--text-body`           | Body text                                 |
| `text_muted`       | `--text-secondary`      | Labels, captions, icons                   |
| `status_online`    | `--status-success`      | A monitor that is up                      |
| `status_info`      | `--status-info`         | A monitor that is healthy but busy, e.g. syncing |
| `status_warning`   | `--status-warning-text` | A monitor in warning                      |
| `status_failed`    | `--status-danger`       | A monitor that has failed                 |
| `status_unavailable` | `--text-tertiary`     | A monitor that could not measure          |

```yaml
theme:
  scheme: auto
  primary: "#7c3aed"
```
