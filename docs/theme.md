# Theme

The dashboard is themed with **Halon**, the X-Tech theme: slate plus a single blue, a recessed navigation frame,
ghost-first controls and hairline structure, in a light and a dark scheme that share one token set. Every colour lives
in Halon's `halon-tokens.css`, the component rules that use those tokens in `halon.css`, and X-Monitor's own styles
(`src/web/app.css`, `src/web/widgets/widgets.css`) use only the tokens. The charts are drawn with the same tokens, so
they follow the scheme too.

The scheme follows the system's light or dark setting until you pick one with the theme button in the top bar. The
choice is kept in that browser.

The `theme:` section of `config.yaml` (`scheme` and token overrides such as `primary`) is read, and a change to it is
reported as needing a restart, but the page does not apply it.
