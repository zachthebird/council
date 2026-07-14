# Example task prompts

Paste any of these into `moh run --task "…"` (or `--task-file`, or `--stdin`). They work
well with two independently configured seats and a final structured review.

1. **Bug fix with tests**
   > In this repository, `parseDuration()` returns NaN for inputs like "1h30m". Fix it to
   > support combined units, and add unit tests covering "45s", "2m", "1h30m", and "0".

2. **Small feature**
   > Add a `--json` flag to the existing CLI that prints the command's result as a single
   > JSON object with no ANSI. Keep the human output unchanged by default.

3. **Refactor for clarity**
   > Extract the retry/backoff logic in `client.mjs` into a reusable `withRetry(fn, opts)`
   > helper, preserve behavior, and add a focused test for the backoff schedule.

4. **Greenfield utility** (works with `--seed greenfield`)
   > Create a tiny `slugify(text)` module that lowercases, trims, collapses whitespace to
   > single hyphens, strips non-alphanumerics, and handles empty input. Include tests.

5. **Docs + code**
   > Document the public functions in `src/format.mjs` with JSDoc and add a short usage
   > section to the README, without changing behavior.

6. **Performance**
   > The `dedupe()` function is O(n²). Make it O(n) while preserving first-seen order, and
   > add a test asserting order preservation on 10k items.

Tip: for a lower-invocation run, use `--preset quick-compare` — two independent solutions,
your pick, one review.
