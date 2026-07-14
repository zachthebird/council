// DEPRECATED compatibility shim. The legacy Council entrypoint was `node server.mjs`.
// Mixture of Harnesses replaces it with the `moh` CLI. This shim forwards to the
// hardened loopback web companion (`moh web`) and prints a one-time deprecation
// notice. It will be removed in a future release.
process.stderr.write(
  '[deprecation] `node server.mjs` is deprecated. Use `moh web` (browser companion) ' +
    'or `moh` (TUI). Forwarding to `moh web` for this release.\n'
);
const { startWeb } = await import('./src/web/server.mjs');
await startWeb(process.argv.slice(2));
