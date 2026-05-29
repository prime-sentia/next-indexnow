# Releasing

Publishing is automated via [`.github/workflows/release.yml`](.github/workflows/release.yml), which runs lint + format + typecheck + build + test and then `npm publish` on every published GitHub Release. It uses **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret — and npm generates a [provenance](https://docs.npmjs.com/generating-provenance-statements) statement automatically.

## One-time setup

On npmjs.com, open the `next-indexnow` package → **Settings → Trusted Publisher** → **GitHub Actions**, and set:

- **Organization or user:** `primesentia`
- **Repository:** `next-indexnow`
- **Workflow filename:** `release.yml`
- **Environment:** _(leave blank — the workflow doesn't use one)_

That's it. Once configured, npm accepts publishes from that workflow with no long-lived token. (You can delete any leftover `NPM_TOKEN` secret and npm automation tokens.)

> Trusted Publishing requires the package to already exist on npm and npm CLI ≥ 11.5.1 — the workflow installs the latest npm before publishing.

## Cutting a release

1. Bump the version: `npm version patch` (or `minor` / `major`). This updates `package.json` and creates a `vX.Y.Z` git tag.
2. Push the commit and tag: `git push --follow-tags`.
3. Create a **GitHub Release** for that tag: `gh release create vX.Y.Z --generate-notes`.

Publishing the release triggers the workflow. It fails fast if the tag doesn't match `package.json`'s version, so they can't drift. Every published version carries CI provenance.
