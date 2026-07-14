# Screenshots & terminal recordings

All captures should use **demo data** (`moh demo`), which is deterministic and contains no
real credentials, repositories, or model calls — safe to publish.

## Record a terminal session (asciinema)

```bash
# install asciinema (https://asciinema.org) then:
asciinema rec moh-demo.cast -c "NO_COLOR= node bin/moh.mjs demo"
# convert to SVG/GIF with agg or svg-term-cli if desired:
#   agg moh-demo.cast moh-demo.gif
```

## Capture the TUI

```bash
asciinema rec moh-tui.cast -c "node bin/moh.mjs"
# then press 1 (run demo), watch the live workflow, q to quit.
```

## Capture the web companion

```bash
node bin/moh.mjs web           # open http://127.0.0.1:7373, click "Run deterministic demo"
```

Take an OS screenshot of the two seat cards + live feed. The page shows one seat that
reports its model and one that honestly does not (`Not reported by harness`).

## What is safe to show

`moh demo` output is safe by construction. If you record a **real** run, first run
`moh export <run-id>` (privacy-safe by default) and screenshot that instead of raw prompts
or repository content. Never publish a capture that includes secret values — moh redacts
them, but review before sharing.
