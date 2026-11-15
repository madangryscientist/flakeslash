# Releasing the CLI

Only `@hackcove/flakeslash` (`packages/cli`) is published. Its bundle includes the engine, so
`@hackcove/flakeslash-engine` stays private. A release publishes the version in
`packages/cli/package.json` through the manual `Publish` workflow (`.github/workflows/publish.yml`),
which runs only from `main`.

Check the tarball locally first: `npm pack --dry-run` in `packages/cli` lists `dist/index.js`,
`package.json`, `README.md`, `LICENSE` and `NOTICE`. Its `prepack` copies the last two in from the
repo root (git ignores the copies) and rebuilds `dist`.

## The first publish

npm cannot attach a trusted publisher to a package that does not exist yet, so the first publish
uses a token. These are the maintainer's steps, in order:

1. On npmjs.com, create a granular access token that can publish to the `@hackcove` scope, with a
   short expiry and two-factor bypass turned on (CI cannot answer a one-time password prompt).
2. In the repo's GitHub settings, create an environment named `npm-publish`, restricted to the
   `main` branch, and add the token to it as the secret `NPM_TOKEN`.
3. Run the `Publish` workflow from `main` with `dry_run` on. Read the packed file list in the log.
4. Run it again with `dry_run` off. Check `npm view @hackcove/flakeslash`.
5. On npmjs.com, add a trusted publisher to the package: GitHub Actions, repository
   `madangryscientist/flakeslash`, workflow `publish.yml`, environment `npm-publish`.
6. Delete the `NPM_TOKEN` secret from the environment, and revoke the token on npmjs.com.
7. Tag the release and push the tag: `git tag flakeslash@0.1.0 <the published commit>` and
   `git push origin flakeslash@0.1.0`.

## Later publishes

Bump `version` in `packages/cli/package.json` through a pull request. Once it is on `main`, run the
`Publish` workflow with `dry_run` on, then off. It authenticates through the trusted publisher, with
no token. Tag `flakeslash@<version>` on the published commit.
