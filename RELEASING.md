# Releasing

This document describes the **manual, owner-only** release process for
Mixture of Harnesses. It is intended for the project owner
(zachthebird@gmail.com). Contributors do not need to follow this.

There is no automated release pipeline that publishes on merge. Releases are
performed deliberately and by hand.

## Guiding constraints

- **CI must pass with no paid model calls and no login.** A release must never
  depend on credentials or network model access. If any test requires those, the
  release is blocked until it is fixed.
- **Never push result branches or user artifacts.** Releasing the package is
  separate from, and must not trigger, any of the tool's own git behavior.
- **Keep the changelog and version honest.** Do not tag a release whose
  CHANGELOG overstates what shipped.

## Pre-release checklist

1. **Bump the version** in `package.json` following SemVer. During beta this is
   typically a `0.x` bump.
2. **Update [`CHANGELOG.md`](CHANGELOG.md)**: move items into a new dated
   version section using the Keep a Changelog format, and update the release
   link.
3. **Run the local gate:**
   ```sh
   npm run check && npm test
   ```
   Both must pass. Tests run with fake harnesses only.

## Build and verify the package

4. **Create the tarball and inspect its contents:**
   ```sh
   npm pack
   tar -tzf mixture-of-harnesses-<version>.tgz
   ```
   Confirm only intended files are included (no secrets, no local state, no
   stray artifacts).

5. **Install the tarball in a clean temp directory and smoke-test the CLI:**
   ```sh
   TMP=$(mktemp -d)
   cd "$TMP"
   npm init -y >/dev/null
   npm install /path/to/mixture-of-harnesses-<version>.tgz
   npx moh --help
   npx moh doctor
   npx moh demo
   ```
   - `moh --help` should list commands.
   - `moh doctor` should report environment status without requiring
     credentials.
   - `moh demo` should run the deterministic, zero-token demo to completion.

## Publish artifacts

6. **Create the GitHub release:**
   - Draft a release for the new tag with notes derived from the CHANGELOG.
   - Attach the tarball and generate checksums:
     ```sh
     shasum -a 256 mixture-of-harnesses-<version>.tgz
     ```
   - If practical, generate and attach a Software Bill of Materials (SBOM).
     Given the zero-runtime-dependency design, this should be small.

## Owner-only steps

These steps require repository/organization ownership and should only be done by
the owner, typically for the first public release:

7. **Rename the GitHub repository** to its public name if it has not been
   renamed already.
8. **Make the repository public.**
   - Also confirm the `repository`/`homepage`/`bugs` URLs in `package.json` point at
     the real org/handle. They currently default to `github.com/zachthebird/...`
     (derived from the owner email); update if the actual GitHub owner differs.
9. **Configure npm trusted publishing (OIDC)** so publishes are authenticated
   via CI identity rather than a long-lived token.
10. **Publish to npm.** During beta, publish under an appropriate dist-tag
    (e.g. `beta`) if you do not want it to become `latest` automatically.

## Post-release

- Verify the published package installs cleanly from the registry in a fresh
  temp directory and that `moh --help`, `moh doctor`, and `moh demo` still work.
- Open a new `Unreleased`/next section in the CHANGELOG for subsequent work.
