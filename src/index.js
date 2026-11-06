import { createFreebuffAuth, isSameOriginRequest } from '@freebuff/auth'

import {
  ensureSchema,
  exportCsv,
  getAccessLog,
  getBreakdowns,
  getSummary,
  getVisits,
  recordDenial,
  recordVisit,
} from './analytics.js'
import { cloudflareAnalytics } from './cloudflare.js'

const DEFAULT_ADMIN_EMAIL = 'lrosasaamot001@stpaul.k12.mn.us'

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://*.style.dev https://*.freebuff.com https://freebuff.com",
}

const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://*.style.dev https://*.freebuff.com https://freebuff.com",
}

const DEFAULT_EMAILS = [DEFAULT_ADMIN_EMAIL]

function list(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function allowedEmails(env) {
  const configured = list(env.ADMIN_EMAILS)
  return configured.length ? configured : DEFAULT_EMAILS
}

function isLoopback(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(origin || ''))
}

function isAllowed(env, user) {
  if (!user || !user.sub) return false
  const subs = list(env.ADMIN_SUBS)
  if (subs.includes(String(user.sub).toLowerCase())) return true
  if (!user.email) return false
  if (user.email_verified === false) return false
  return allowedEmails(env).includes(String(user.email).trim().toLowerCase())
}

let authState = { key: '', auth: null, wrapped: null }

function getAuth(env) {
  if (!env.FREEBUFF_CLIENT_ID || !env.APP_ORIGIN) return null
  const key = `${env.FREEBUFF_CLIENT_ID}|${env.APP_ORIGIN}|${env.FREEBUFF_ISSUER || ''}`
  if (authState.key === key && authState.auth) return authState
  const auth = createFreebuffAuth({
    clientId: env.FREEBUFF_CLIENT_ID,
    baseUrl: env.APP_ORIGIN,
    issuer: env.FREEBUFF_ISSUER || undefined,
    scopes: ['openid', 'email', 'profile'],
    allowInsecureLocalhost: isLoopback(env.APP_ORIGIN),
  })
  authState = {
    key,
    auth,
    wrapped: auth.wrap((request, innerEnv, ctx) => handle(request, innerEnv, ctx)),
  }
  return authState
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function html(body, status = 200) {
  return new Response(body, { status, headers: HTML_HEADERS })
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function notFoundPage() {
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · leo.textnexus.me</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="notfound">
  <div>
    <h1>404</h1>
    <p>That page doesn't exist here.</p>
    <a class="btn" href="/">Back home</a>
  </div>
</main>
</body>
</html>`, 404)
}

function withPageHeaders(response) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function gatePage({ kind, user, env }) {
  const emails = allowedEmails(env)
  const title =
    kind === 'denied' ? 'Access denied' : kind === 'setup' ? 'Setup needed' : 'Owner sign-in'
  const body =
    kind === 'denied'
      ? `<p>You are signed in as <strong>${escapeHtml(
          user && user.email ? user.email : 'an unknown account',
        )}</strong>, but only the site owner can open this dashboard.</p>
         <p class="muted">Signed in with the wrong account? Sign out, then sign in as ${escapeHtml(
           emails[0],
         )}.</p>
         <form method="POST" action="/auth/freebuff/signout"><button class="btn ghost" type="submit">Sign out</button></form>`
      : kind === 'setup'
        ? `<p>Sign in with Freebuff is not configured for this deployment yet.</p>
           <p class="muted">Add <code>FREEBUFF_CLIENT_ID</code>, <code>FREEBUFF_ISSUER</code> and <code>APP_ORIGIN</code> to the site, then reload.</p>`
        : `<p>This area is private. Sign in with the owner's Freebuff account to continue.</p>
           <p class="muted">Access is limited to ${escapeHtml(emails[0])}.</p>
           <p><a class="btn" href="/auth/freebuff/signin?returnTo=%2Fadmin">Sign in with Freebuff</a></p>`

  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · leo.textnexus.me</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="gate-body">
<main class="gate">
  <div class="gate-badge">Private</div>
  <h1>${title}</h1>
  <div class="gate-copy">${body}</div>
  <a class="gate-back" href="/">&larr; Back to leo.textnexus.me</a>
</main>
</body>
</html>`, kind === 'signin' ? 401 : 403)
}

async function resolveUser(request, env, auth) {
  const signedIn = auth ? await auth.getUser(request) : null
  if (signedIn) return signedIn
  // Local-only convenience: `wrangler dev` can preview the dashboard without a
  // browser session. Requires a loopback APP_ORIGIN, so it is inert in production.
  if (env.DEV_FAKE_USER && isLoopback(env.APP_ORIGIN)) {
    return { sub: 'dev-local', email: env.DEV_FAKE_USER, email_verified: true, name: 'Dev preview' }
  }
  return null
}

async function adminPage(request, env) {
  const state = getAuth(env)
  if (!state) return gatePage({ kind: 'setup', env })

  const user = await resolveUser(request, env, state.auth)
  if (!user) return gatePage({ kind: 'signin', env })
  if (!isAllowed(env, user)) return gatePage({ kind: 'denied', user, env })

  // Cloudflare Assets serve /admin from admin.html and redirect explicit
  // .html paths, so forward the canonical URL rather than rewriting it.
  return withPageHeaders(await env.ASSETS.fetch(request))
}

function numberFrom(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

async function adminApi(request, env, ctx) {
  const url = new URL(request.url)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!isSameOriginRequest(request, env.APP_ORIGIN)) {
      return json({ error: 'Cross-origin request rejected' }, 403)
    }
  }

  const state = getAuth(env)
  if (!state) return json({ error: 'Sign in with Freebuff is not configured', setup: true }, 503)

  const user = await resolveUser(request, env, state.auth)
  if (!user) return json({ error: 'Sign in required' }, 401)

  if (!isAllowed(env, user)) {
    ctx.waitUntil(recordDenial(env, request, user))
    return json({ error: 'Not authorized' }, 403)
  }

  const days = numberFrom(url.searchParams.get('days'), 7, 0, 365)
  const route = url.pathname.replace('/api/admin', '')

  try {
    if (route === '/summary') return json(await getSummary(env, days))

    if (route === '/breakdowns') return json(await getBreakdowns(env, days))

    if (route === '/visits') {
      const limit = numberFrom(url.searchParams.get('limit'), 50, 1, 200)
      const offset = numberFrom(url.searchParams.get('offset'), 0, 0, 1_000_000)
      const bots = url.searchParams.get('bots') === '1'
      return json(await getVisits(env, { days, bots, limit, offset }))
    }

    if (route === '/cloudflare') {
      return json(await cloudflareAnalytics(env, days || 30))
    }

    if (route === '/access') {
      return json({
        ...(await getAccessLog(env)),
        you: { email: user.email || null, name: user.name || null, sub: user.sub },
      })
    }

    if (route === '/visits.csv') {
      const bots = url.searchParams.get('bots') === '1'
      const csv = await exportCsv(env, days, bots)
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="leo-visits-${new Date()
            .toISOString()
            .slice(0, 10)}.csv"`,
          'cache-control': 'private, no-store',
        },
      })
    }

    return json({ error: 'Unknown endpoint' }, 404)
  } catch (error) {
    console.error('admin api failed:', route, error && error.message)
    const message = error && error.message ? error.message : 'Unexpected error'
    return json({ error: message }, 500)
  }
}

function shouldTrack(request) {
  if (request.method !== 'GET') return false
  if (request.headers.get('dnt') === '1') return false
  if (request.headers.get('sec-gpc') === '1') return false
  const accept = request.headers.get('accept') || ''
  if (!accept.includes('text/html')) return false
  return true
}

async function handle(request, env, ctx) {
  const url = new URL(request.url)
  const { pathname } = url

  if (pathname === '/healthz') return json({ ok: true })

  if (pathname.startsWith('/api/admin')) return adminApi(request, env, ctx)

  if (pathname === '/admin' || pathname === '/admin/') return adminPage(request, env)

  if (pathname === '/admin.html' || pathname === '/index.html') {
    return Response.redirect(new URL(pathname === '/index.html' ? '/' : '/admin', url), 308)
  }

  const isPage = request.method === 'GET' && !pathname.includes('.')

  if (!isPage) return env.ASSETS.fetch(request)

  const response = await env.ASSETS.fetch(request)

  if (response.status === 404) {
    if (shouldTrack(request)) ctx.waitUntil(recordVisit(request, env, 404))
    return withPageHeaders(notFoundPage())
  }

  if (shouldTrack(request)) ctx.waitUntil(recordVisit(request, env, response.status))

  return withPageHeaders(response)
}

export default {
  async fetch(request, env, ctx) {
    const state = getAuth(env)
    if (!state) return handle(request, env, ctx)
    return state.wrapped(request, env, ctx)
  },
}
