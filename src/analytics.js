// Visit tracking + reporting backed by D1.
//
// Every public page view is recorded with the edge metadata Cloudflare passes
// to the Worker (country, city, colo, ASN, timezone) plus a privacy-preserving
// daily visitor hash. Raw IP addresses are never stored.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT,
    referrer TEXT,
    referrer_host TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    colo TEXT,
    timezone TEXT,
    asn INTEGER,
    as_org TEXT,
    device TEXT,
    browser TEXT,
    os TEXT,
    is_bot INTEGER NOT NULL DEFAULT 0,
    visitor TEXT NOT NULL,
    status INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (day)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits (visitor)`,
  `CREATE TABLE IF NOT EXISTS access_denied (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    email TEXT,
    sub TEXT,
    country TEXT
  )`,
]

let schemaReady = null

export function ensureSchema(env) {
  if (!env.DB) return Promise.reject(new Error('D1 binding "DB" is missing'))
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA) await env.DB.prepare(statement).run()
    })().catch((error) => {
      schemaReady = null
      throw error
    })
  }
  return schemaReady
}

const DAY_MS = 86_400_000
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

function cutoffDay(days) {
  if (!days) return '0000-01-01'
  return utcDay(Date.now() - (days - 1) * DAY_MS)
}

async function visitorHash(ip, userAgent, day, salt) {
  const input = new TextEncoder().encode(`${ip}|${userAgent}|${day}|${salt}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const BOT_PATTERN =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|discordbot|headlesschrome|python-requests|curl\/|wget\/|monitor|uptime|pingdom|lighthouse|preview/i

function userAgentDevices(userAgent) {
  const ua = userAgent || ''
  const isBot = BOT_PATTERN.test(ua)
  const isTablet = /ipad|tablet|kindle|silk/i.test(ua)
  const isMobile = !isTablet && /mobi|iphone|android|phone|ipod/i.test(ua)
  let browser = 'Other'
  if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome'
  else if (/safari/i.test(ua)) browser = 'Safari'
  else if (isBot) browser = 'Bot'
  let os = 'Other'
  if (/windows/i.test(ua)) os = 'Windows'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/iphone|ipad|ipod|ios/i.test(ua)) os = 'iOS'
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS'
  else if (/linux/i.test(ua)) os = 'Linux'
  return {
    isBot: isBot ? 1 : 0,
    device: isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop',
    browser,
    os,
  }
}

function referrerHost(referrer, ownHost) {
  if (!referrer) return ''
  try {
    const host = new URL(referrer).host
    if (!host) return ''
    return host === ownHost ? 'internal' : host.slice(0, 120)
  } catch {
    return ''
  }
}

/** Record one public page view. Never throws into the response path. */
export async function recordVisit(request, env, status) {
  try {
    await ensureSchema(env)
    const url = new URL(request.url)
    const headers = request.headers
    const ua = (headers.get('user-agent') || '').slice(0, 400)
    const cf = request.cf || {}
    const now = Date.now()
    const day = utcDay(now)
    const { isBot, device, browser, os } = userAgentDevices(ua)
    const visitor = await visitorHash(
      headers.get('cf-connecting-ip') || '',
      ua,
      day,
      env.IP_SALT || 'leo-textnexus',
    )

    await env.DB.prepare(
      `INSERT INTO visits (ts, day, path, query, referrer, referrer_host, country, region, city,
        colo, timezone, asn, as_org, device, browser, os, is_bot, visitor, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        now,
        day,
        url.pathname.slice(0, 300),
        url.search.slice(0, 400),
        (headers.get('referer') || '').slice(0, 500),
        referrerHost(headers.get('referer') || '', url.host),
        cf.country || null,
        cf.region || null,
        cf.city || null,
        cf.colo || null,
        cf.timezone || null,
        typeof cf.asn === 'number' ? cf.asn : null,
        cf.asOrganization ? String(cf.asOrganization).slice(0, 120) : null,
        device,
        browser,
        os,
        isBot,
        visitor,
        Number.isFinite(status) ? status : 200,
      )
      .run()
  } catch (error) {
    console.error('visit tracking failed:', error && error.message)
  }
}

/** Log a signed-in account that tried to open the admin panel without access. */
export async function recordDenial(env, request, user) {
  try {
    await ensureSchema(env)
    const cf = request.cf || {}
    await env.DB.prepare(
      'INSERT INTO access_denied (ts, email, sub, country) VALUES (?, ?, ?, ?)',
    )
      .bind(
        Date.now(),
        (user && user.email ? String(user.email) : '').slice(0, 200),
        (user && user.sub ? String(user.sub) : '').slice(0, 200),
        cf.country || null,
      )
      .run()
  } catch (error) {
    console.error('denial logging failed:', error && error.message)
  }
}

const TOTAL_FIELDS = `COUNT(*) AS visits,
  COALESCE(SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END), 0) AS humans,
  COUNT(DISTINCT CASE WHEN is_bot = 0 THEN visitor END) AS uniques,
  COUNT(DISTINCT CASE WHEN is_bot = 1 THEN visitor END) AS bot_uniques`

export async function getSummary(env, days) {
  await ensureSchema(env)
  const cutoff = cutoffDay(days)
  const now = Date.now()
  const today = utcDay(now)

  const current = await env.DB.prepare(
    `SELECT ${TOTAL_FIELDS} FROM visits WHERE day >= ?`,
  )
    .bind(cutoff)
    .first()

  const previous = days
    ? await env.DB.prepare(
        `SELECT ${TOTAL_FIELDS} FROM visits WHERE day >= ? AND day < ?`,
      )
        .bind(utcDay(now - (days * 2 - 1) * DAY_MS), cutoff)
        .first()
    : null

  const daily = await env.DB.prepare(
    `SELECT day, COUNT(*) AS visits,
      COALESCE(SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END), 0) AS humans,
      COUNT(DISTINCT CASE WHEN is_bot = 0 THEN visitor END) AS uniques
     FROM visits WHERE day >= ? GROUP BY day ORDER BY day ASC`,
  )
    .bind(cutoff)
    .all()

  const live = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM visits WHERE ts >= ? AND is_bot = 0',
  )
    .bind(now - 5 * 60_000)
    .first()

  const nowToday = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM visits WHERE day = ? AND is_bot = 0',
  )
    .bind(today)
    .first()

  const firstEver = await env.DB.prepare('SELECT MIN(day) AS day FROM visits').first()

  return {
    days,
    generatedAt: new Date(now).toISOString(),
    totals: current || { visits: 0, humans: 0, uniques: 0, bot_uniques: 0 },
    previous,
    live: live ? live.n : 0,
    today: nowToday ? nowToday.n : 0,
    firstDay: firstEver ? firstEver.day : null,
    daily: daily.results || [],
  }
}

const GROUPS = {
  path: 'path',
  country: 'country',
  referrer: 'referrer_host',
  device: 'device',
  browser: 'browser',
  os: 'os',
  colo: 'colo',
}

export async function getBreakdowns(env, days) {
  await ensureSchema(env)
  const cutoff = cutoffDay(days)
  const entries = await Promise.all(
    Object.entries(GROUPS).map(async ([key, column]) => {
      const result = await env.DB.prepare(
        `SELECT ${column} AS label, COUNT(*) AS count
         FROM visits WHERE day >= ? AND is_bot = 0 AND ${column} IS NOT NULL AND ${column} != ''
         GROUP BY ${column} ORDER BY count DESC LIMIT 8`,
      )
        .bind(cutoff)
        .all()
      return [key, result.results || []]
    }),
  )
  return Object.fromEntries(entries)
}

export async function getVisits(env, { days, bots, limit, offset }) {
  await ensureSchema(env)
  const cutoff = cutoffDay(days)
  const where = `WHERE day >= ?${bots ? '' : ' AND is_bot = 0'}`
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM visits ${where}`)
    .bind(cutoff)
    .first()
  const rows = await env.DB.prepare(
    `SELECT ts, path, referrer_host, country, region, city, colo, device, browser, os,
      is_bot, status, as_org
     FROM visits ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
  )
    .bind(cutoff, limit, offset)
    .all()
  return { total: total ? total.n : 0, rows: rows.results || [] }
}

export async function getAccessLog(env) {
  await ensureSchema(env)
  const denials = await env.DB.prepare(
    'SELECT ts, email, sub, country FROM access_denied ORDER BY ts DESC LIMIT 15',
  ).all()
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM access_denied').first()
  return {
    allowedEmails: String(env.ADMIN_EMAILS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    allowedSubs: String(env.ADMIN_SUBS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    deniedTotal: count ? count.n : 0,
    denials: denials.results || [],
  }
}

export async function exportCsv(env, days, bots) {
  await ensureSchema(env)
  const cutoff = cutoffDay(days)
  const where = `WHERE day >= ?${bots ? '' : ' AND is_bot = 0'}`
  const result = await env.DB.prepare(
    `SELECT ts, path, referrer_host, country, city, colo, device, browser, os, is_bot, status
     FROM visits ${where} ORDER BY ts DESC LIMIT 20000`,
  )
    .bind(cutoff)
    .all()
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const header = 'timestamp,iso_time,path,referrer,country,city,colo,device,browser,os,bot,status'
  const lines = (result.results || []).map((row) =>
    [
      row.ts,
      new Date(row.ts).toISOString(),
      row.path,
      row.referrer_host,
      row.country,
      row.city,
      row.colo,
      row.device,
      row.browser,
      row.os,
      row.is_bot ? 1 : 0,
      row.status,
    ]
      .map(escape)
      .join(','),
  )
  return [header, ...lines].join('\n')
}
