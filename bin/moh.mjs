#!/usr/bin/env node
// Mixture of Harnesses — CLI entry. `moh` with no args launches the TUI (guided
// setup on first use). All subcommands share one orchestration core.
import { main } from '../src/cli/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`moh: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  }
);
