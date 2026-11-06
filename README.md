# leo.textnexus.me

Personal site for Leo Rosas Aamot, plus a private admin dashboard for its
traffic.

## What's here

- `/` — public landing page.
- `/admin` — traffic dashboard. Sign-in restricted to the owner's email
  (`lrosasaamot001@stpaul.k12.mn.us`). Anyone else who signs in is turned away
  and logged under **Blocked attempts**.
- `/api/admin/*` — JSON feed for the dashboard. Every route requires a signed-in,
  allowlisted account; signed-out callers get `401` and other accounts get `403`.

### Visit data

Every public page view is recorded in D1 (`visits`) with the edge metadata
Cloudflare attaches to the request — country, region, city, colo, ASN,
timezone — plus device, browser, referrer, status code, and a per-day hashed
visitor ID. Raw IP addresses are never stored, and `DNT`/`Global Privacy
Control` requests are skipped.

The dashboard shows: human vs. bot visits per day, unique visitors, top pages,
countries, referrers, browsers, recent visits (paginated), CSV export, and the
access log.

### Cloudflare zone traffic (optional)

The panel titled **Cloudflare zone traffic** additionally shows the numbers
Cloudflare keeps for the `textnexus.me` zone. It needs two secrets:

| Name | Value |
| --- | --- |
| `CF_API_TOKEN` | A Cloudflare API token with **Zone → Analytics → Read** for `textnexus.me` |
| `CF_ZONE_ID` | `cafa8c8771283cda1b0bedd56be69b52` |

Set them in Sites → Secrets (or `npx wrangler secret put` for a custom deploy).
Without them, that panel explains how to connect and the rest of the dashboard
still works.

## Local development

```sh
npm install
npx wrangler dev --port 8787
```

`.dev.vars` holds the local Sign in with Freebuff client and `APP_ORIGIN`.
For local UI work without a browser session, add:

```
DEV_FAKE_USER=lrosasaamot001@stpaul.k12.mn.us
```

That shortcut only applies when `APP_ORIGIN` is a loopback address, so it is
inert in production. Never set it in the hosted environment.

Local D1 lives in `.wrangler/state`. The schema is created automatically on the
first request.

## Deployment

The site is hosted on Freebuff Sites. Build the worker bundle and deploy the
preview environment with `sites_deploy` using `manifest.json`:

```sh
npm run build          # wrangler deploy --dry-run --outdir=dist
```

`FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN` are injected by the
platform at deploy time; no secrets are committed. Production publishing is a
separate, explicit step.

## Access control

`ADMIN_EMAILS` (comma-separated, defaults to the owner's address) is the
allowlist. Optional `ADMIN_SUBS` pins access to Freebuff account IDs as well,
which survives an email change. Access is enforced server-side on `/admin` and
on every `/api/admin/*` request — hiding the UI is never the check.
