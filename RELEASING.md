# Releasing

Publishing is automated via [`.github/workflows/release.yml`](.github/workflows/release.yml), which runs lint + format + typecheck + build + test and then `npm publish` with [provenance](https://docs.npmjs.com/generating-provenance-statements) on every published GitHub Release.

## One-time setup

1. Create an npm **Automation** (or Granular Access) token with publish rights for `next-indexnow`.
2. Add it to the repo as a secret named **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).

The workflow already requests `id-token: write`, and `publishConfig.provenance` is enabled in `package.json`, so published builds get a verified provenance statement (the repo must be public).

## Cutting a release

1. Bump the version: `npm version patch` (or `minor` / `major`). This updates `package.json` and creates a `vX.Y.Z` git tag.
2. Push the commit and tag: `git push && git push --tags`.
3. Create a **GitHub Release** for that tag (`gh release create vX.Y.Z --generate-notes`).

Publishing the release triggers the workflow. It fails fast if the tag doesn't match `package.json`'s version, so they can't drift.

> No manual `npm publish` from a laptop is needed — and shouldn't be used, so every published version carries CI provenance.
