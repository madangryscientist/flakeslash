# Deploying the dashboard

The dashboard (`apps/web`) is one Cloudflare Worker with a D1 database and two cron triggers: the
hourly scan and the daily expiry. These steps deploy your own copy. Run every command from `apps/web`
after `bun install` at the repo root.

## Credentials

wrangler reads two variables from the environment. No `wrangler login` is needed:

```bash
export CLOUDFLARE_API_TOKEN=...   # a token that can edit Workers, D1 and the zone's routes
export CLOUDFLARE_ACCOUNT_ID=...
```

Keep both out of the tree and out of shell history.

## 1. The database

```bash
bunx wrangler d1 create flakeslash
```

Put the id it prints in `wrangler.jsonc`, as the `database_id` of the top-level `d1_databases` entry.
Leave the one under `env.e2e` alone: the browser tests use a local database.

## 2. The GitHub App

Sign-in is the App's user authorization, and the scan uses its installation tokens. The App needs no
webhook. Register it on GitHub (Settings, Developer settings, GitHub Apps), or through GitHub's
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
with this manifest, where `<host>` is your dashboard's hostname:

```json
{
  "name": "FlakeSlash",
  "url": "https://<host>",
  "callback_urls": ["https://<host>/auth/github/callback"],
  "request_oauth_on_install": false,
  "hook_attributes": { "url": "https://<host>/", "active": false },
  "public": false,
  "default_permissions": {
    "actions": "read",
    "contents": "read",
    "checks": "write",
    "metadata": "read",
    "members": "read"
  }
}
```

An App name is unique on GitHub, so pick another if that one is taken. `public: false` keeps the App
installable on its owner's account only.

Put the App's id in `GITHUB_APP_ID` and its client id in `GITHUB_APP_CLIENT_ID`, both under the
top-level `vars` of `wrangler.jsonc`. They are public values.

## 3. The domain

Add the hostname to `wrangler.jsonc` as a custom domain:

```jsonc
"routes": [{ "pattern": "<host>", "custom_domain": true }],
```

The zone must be on the same Cloudflare account. Cloudflare creates the DNS record and the
certificate on the first deploy and owns both. Do not add a record for the hostname yourself: the
deploy then fails with "hostname already has a DNS record".

## 4. Migrations, then the deploy

```bash
bunx wrangler d1 migrations apply DB --remote
bun run build
bunx wrangler deploy
```

Apply the migrations before every deploy that brings new ones.

## 5. The secrets

The Worker refuses to serve without them. `wrangler secret put` reads each value from stdin:

```bash
bunx wrangler secret put GITHUB_APP_CLIENT_SECRET   # the App's client secret
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY     # the App's private key, the whole PEM
openssl rand -base64 32 | bunx wrangler secret put TOKEN_KEY
```

`TOKEN_KEY` seals the GitHub tokens a session keeps. Changing it signs everyone out.

## Sizing

The scan's bounds are vars in `wrangler.jsonc`: `SCAN_REQUEST_BUDGET` (GitHub requests per batch),
`SCAN_REPOS_PER_BATCH`, and `SCAN_D1_CAP` (D1 statements per batch, 950 when unset). The values in the
repo fit Cloudflare's free plan (50 subrequests and 50 D1 queries per invocation). On the paid plan
you can raise them: 200, 20 and 950 fit its limits of 1,000 each. `src/scan/hourly-bounds.test.ts`
measures a batch at whatever the file says, so change the values and the test together.

## Checking it

Open `https://<host>`: it renders signed out. Sign in with GitHub, install the App on a few repos,
and the catalogue fills within an hour or two. Workers Logs (on, through `observability`) show each
batch's line, and any `exceededCpu` or D1 limit error.
