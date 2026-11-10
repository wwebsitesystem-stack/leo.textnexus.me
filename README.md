# leo.textnexus.me

This site has been shut down. It is no longer a personal site and there is no
admin area or traffic dashboard.

`/` serves a single static shutdown notice explaining that the site was shut
down by the co-owner of Nexus for going against Nexus policy, and asking anyone
affected to email `web.solutions@textnexus.me` if a mistake was made.

## Structure

- `public/index.html` — the only page, fully self-contained (inline CSS, no
  external assets).
- `src/index.js` — minimal worker that serves the static assets.
- `manifest.json` — Sites deployment manifest for the built worker.

## Local development

```sh
npm install
npx wrangler dev --port 8787
```

## Deployment

The shutdown page is static, so it deploys to GitHub Pages from `main` through
`.github/workflows/pages.yml`, which publishes the contents of `public/`.

It can also be hosted on Freebuff Sites. Build the worker bundle and deploy
with `sites_deploy` using `manifest.json`:

```sh
npm run build          # wrangler deploy --dry-run --outdir=dist
```
