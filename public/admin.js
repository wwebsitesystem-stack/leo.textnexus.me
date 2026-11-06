// Admin dashboard: reads the private JSON API and renders it with DOM APIs so
// visit data (paths, referrers) is never interpreted as markup.

const $ = (selector) => document.querySelector(selector)
const SVG_NS = 'http://www.w3.org/2000/svg'

const state = { days: 7, bots: false, offset: 0, limit: 25 }

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' })
  } catch {
    return null
  }
})()

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function svgEl(tag, props = {}) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue
    node.setAttribute(key, String(value))
  }
  return node
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return payload
}

function showError(message) {
  const banner = $('#error')
  banner.textContent = message
  banner.hidden = !message
}

function toast(message) {
  const node = $('#toast')
  node.textContent = message
  node.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => {
    node.hidden = true
  }, 1800)
}

function countryLabel(code) {
  if (!code) return 'Unknown'
  const upper = String(code).toUpperCase()
  const flag = /^[A-Z]{2}$/.test(upper)
    ? String.fromCodePoint(...[...upper].map((char) => 127397 + char.charCodeAt(0)))
    : '🌐'
  let name = upper
  if (regionNames) {
    try {
      name = regionNames.of(upper) || upper
    } catch {
      name = upper
    }
  }
  return `${flag} ${name}`
}

function timeAgo(ms) {
  const seconds = Math.round((Date.now() - Number(ms)) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 90) return '1 min ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(Number(ms)).toLocaleDateString()
}

function absolute(ms) {
  return new Date(Number(ms)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function delta(value, previous) {
  if (!previous) {
    return value > 0 ? el('span', { class: 'delta up', text: 'new' }) : el('span', { class: 'delta flat', text: '—' })
  }
  const change = Math.round(((value - previous) / previous) * 100)
  if (Math.abs(change) < 1) return el('span', { class: 'delta flat', text: 'flat' })
  const up = change > 0
  return el('span', {
    class: `delta ${up ? 'up' : 'down'}`,
    text: `${up ? '↑' : '↓'} ${Math.abs(change)}%`,
  })
}

function renderKpis(summary) {
  const { totals, previous, live, today } = summary
  const visits = totals.humans || 0
  const uniques = totals.uniques || 0
  const bots = Math.max(0, (totals.visits || 0) - visits)
  const botShare = totals.visits ? Math.round((bots / totals.visits) * 100) : 0

  const cards = [
    { label: 'Human visits', value: visits, previous: previous && previous.humans, meta: `${nf.format(today)} today` },
    { label: 'Unique visitors', value: uniques, previous: previous && previous.uniques, meta: 'deduped per day' },
    { label: 'Bot requests', value: bots, meta: `${botShare}% of all traffic` },
    { label: 'On site now', value: live, meta: 'last 5 minutes', tone: 'live' },
  ]

  const host = $('#kpis')
  host.textContent = ''
  for (const card of cards) {
    host.append(
      el(
        'div',
        { class: `kpi${card.tone ? ` ${card.tone}-kpi` : ''}` },
        el('div', { class: 'kpi-label', text: card.label }),
        el('div', { class: 'kpi-value', text: compact.format(card.value || 0) }),
        el('div', { class: 'kpi-meta' }, delta(card.value || 0, card.previous), el('span', { text: card.meta })),
      ),
    )
  }

  const liveBadge = $('#live')
  liveBadge.hidden = !(live > 0)
}

function renderChart(points) {
  const host = $('#chart')
  host.textContent = ''

  if (!points.length) {
    host.append(el('p', { class: 'empty', text: 'No visits recorded in this range yet.' }))
    return
  }

  const width = 880
  const height = 240
  const padTop = 14
  const padBottom = 30
  const plotHeight = height - padTop - padBottom
  const max = Math.max(1, ...points.map((point) => point.visits))
  const slot = width / points.length
  const barWidth = Math.max(3, Math.min(40, slot * 0.6))
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Visits per day',
  })

  for (let index = 0; index <= 4; index += 1) {
    const y = padTop + (plotHeight / 4) * index
    svg.append(svgEl('line', { x1: 0, x2: width, y1: y, y2: y, class: 'grid' }))
  }

  const labelEvery = Math.max(1, Math.ceil(points.length / 9))

  points.forEach((point, index) => {
    const humanHeight = max ? (point.humans / max) * plotHeight : 0
    const botHeight = max ? ((point.visits - point.humans) / max) * plotHeight : 0
    const baseY = padTop + plotHeight
    const x = slot * index + (slot - barWidth) / 2
    const group = svgEl('g', {})

    if (humanHeight > 0) {
      group.append(
        svgEl('rect', {
          x,
          y: baseY - humanHeight,
          width: barWidth,
          height: Math.max(2, humanHeight),
          rx: Math.min(4, barWidth / 2),
          class: 'bar-human',
        }),
      )
    }
    if (botHeight > 0.5) {
      group.append(
        svgEl('rect', {
          x,
          y: baseY - humanHeight - botHeight,
          width: barWidth,
          height: Math.max(2, botHeight),
          class: 'bar-bot',
        }),
      )
    }

    const title = svgEl('title', {})
    title.textContent = `${point.day} — ${nf.format(point.humans)} visits, ${nf.format(point.uniques)} unique`
    group.append(title)
    svg.append(group)

    if (index % labelEvery === 0 || index === points.length - 1) {
      const label = svgEl('text', {
        x: slot * index + slot / 2,
        y: height - 10,
        class: 'axis-label',
        'text-anchor': 'middle',
      })
      label.textContent = String(point.day || '').slice(5)
      svg.append(label)
    }
  })

  host.append(svg)
}

function renderBars(selector, rows, formatter) {
  const host = $(selector)
  host.textContent = ''

  if (!rows || !rows.length) {
    host.append(el('li', { class: 'empty', text: 'No data yet' }))
    return
  }

  const max = Math.max(...rows.map((row) => row.count)) || 1

  for (const row of rows) {
    const label = formatter ? formatter(row.label) : row.label
    host.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'bar-row' },
          el('span', { class: 'bar-label', title: String(row.label || '') }, label),
          el('span', { class: 'bar-count', text: nf.format(row.count) }),
        ),
        el(
          'div',
          { class: 'bar-track' },
          el('div', {
            class: 'bar-fill',
            style: `width:${Math.max(3, Math.round((row.count / max) * 100))}%`,
          }),
        ),
      ),
    )
  }
}

function renderBreakdowns(data) {
  renderBars('#pages', data.path, (value) => value)
  renderBars('#countries', data.country, countryLabel)
  renderBars('#referrers', data.referrer, (value) => (value === 'internal' ? 'internal links' : value))
  renderBars('#devices', data.browser, (value) => value)
}

function renderVisits(data) {
  const body = $('#visits')
  body.textContent = ''

  if (!data.rows.length) {
    body.append(el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'Nothing here yet.' })))
  } else {
    for (const row of data.rows) {
      const where = [countryLabel(row.country), row.city, row.colo ? `(${row.colo})` : null]
        .filter(Boolean)
        .join(' · ')

      body.append(
        el(
          'tr',
          {},
          el('td', { class: 'when', title: absolute(row.ts) }, timeAgo(row.ts)),
          el('td', { class: 'path', title: String(row.path || '') }, String(row.path || '/')),
          el('td', {}, where),
          el('td', {}, row.referrer_host ? String(row.referrer_host) : el('span', { class: 'sub', text: 'direct' })),
          el(
            'td',
            {},
            `${row.browser || 'Unknown'} · ${row.device || 'Device'}`,
            row.is_bot ? el('span', { class: 'badge warn', text: 'bot' }) : null,
          ),
          el(
            'td',
            {},
            el('span', {
              class: `badge ${Number(row.status) >= 400 ? 'bad' : 'ok'}`,
              text: String(row.status || 200),
            }),
          ),
        ),
      )
    }
  }

  const total = data.total || 0
  const start = total === 0 ? 0 : state.offset + 1
  const end = Math.min(total, state.offset + state.limit)
  $('#pageinfo').textContent = `${start}–${end} of ${nf.format(total)}`
  $('#newer').disabled = state.offset === 0
  $('#older').disabled = end >= total
}

function renderCloudflare(data) {
  const host = $('#cloudflare')
  const note = $('#cf-note')
  host.textContent = ''

  if (!data.configured) {
    note.textContent = 'optional'
    host.append(
      el(
        'div',
        { class: 'setup' },
        el('p', { text: 'Connect your Cloudflare zone to see the numbers Cloudflare keeps for leo.textnexus.me.' }),
        el(
          'ol',
          {},
          el(
            'li',
            {},
            'Create a Cloudflare API token with ',
            el('code', { text: 'Zone → Analytics → Read' }),
            ' for textnexus.me.',
          ),
          el('li', {}, 'Add it as the site secret ', el('code', { text: 'CF_API_TOKEN' }), '.'),
          el('li', {}, 'Add the zone ID ', el('code', { text: 'CF_ZONE_ID' }), ' (cafa8c8771283cda1b0bedd56be69b52).'),
        ),
        el('p', { class: 'access-note', text: 'Until then, this page still shows every visit recorded at the edge.' }),
      ),
    )
    return
  }

  if (!data.ok) {
    note.textContent = 'connection failed'
    host.append(
      el(
        'div',
        { class: 'setup' },
        el('p', { text: `Cloudflare rejected the request: ${data.error || 'unknown error'}` }),
        el('p', { class: 'access-note', text: 'Check that the token can read zone analytics and that CF_ZONE_ID matches the zone.' }),
      ),
    )
    return
  }

  note.textContent = `last ${data.days} days · zone ${data.zoneId.slice(0, 8)}…`
  const totals = data.totals || {}
  const stats = [
    { label: 'Requests', value: nf.format(totals.requests || 0) },
    { label: 'Page views', value: nf.format(totals.pageViews || 0) },
    { label: 'Unique visitors', value: nf.format(totals.uniques || 0) },
    { label: 'Cached', value: `${totals.requests ? Math.round(((totals.cachedRequests || 0) / totals.requests) * 100) : 0}%` },
    { label: 'Data served', value: `${((totals.bytes || 0) / 1e9).toFixed(2)} GB` },
  ]

  host.append(
    el(
      'div',
      { class: 'cf-stats' },
      ...stats.map((stat) =>
        el('div', { class: 'cf-stat' }, el('span', { text: stat.label }), el('strong', { text: stat.value })),
      ),
    ),
  )

  renderCloudflareSpark(host, data.daily || [])
}

function renderCloudflareSpark(host, daily) {
  if (!daily.length) return
  const width = 880
  const height = 70
  const max = Math.max(1, ...daily.map((point) => point.requests))
  const slot = width / daily.length
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg cf-spark',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Cloudflare requests per day',
  })
  daily.forEach((point, index) => {
    const barHeight = Math.max(2, (point.requests / max) * (height - 6))
    svg.append(
      svgEl('rect', {
        x: slot * index + slot * 0.18,
        y: height - barHeight,
        width: Math.max(2, slot * 0.64),
        height: barHeight,
        rx: 2,
        class: 'bar-human',
      }),
    )
  })
  host.append(svg)
}

function renderAccess(data) {
  const host = $('#access')
  host.textContent = ''

  const you = data.you || {}
  const emails = data.allowedEmails || []
  const subs = data.allowedSubs || []

  const emailChips = emails.length
    ? emails.map((email) =>
        el(
          'span',
          { class: `chip${String(you.email || '').toLowerCase() === email ? ' you' : ''}` },
          email,
          String(you.email || '').toLowerCase() === email ? ' (you)' : '',
        ),
      )
    : [el('span', { class: 'chip', text: 'ADMIN_EMAILS not set' })]

  host.append(
    el(
      'div',
      { class: 'access-grid' },
      el(
        'div',
        {},
        el('h3', { class: 'access-block', text: 'Allowed accounts' }),
        el('div', { class: 'chips' }, ...emailChips),
        subs.length ? el('div', { class: 'chips', style: 'margin-top:8px' }, ...subs.map((sub) => el('span', { class: 'chip', text: `sub ${sub.slice(0, 12)}…` }))) : null,
        el('p', {
          class: 'access-note',
          text: `Everyone else is turned away before any data loads. Signed in as ${you.email || you.sub || 'unknown'}.`,
        }),
      ),
      el(
        'div',
        { class: 'access-block' },
        el('h3', { text: `Blocked attempts (${nf.format(data.deniedTotal || 0)})` }),
        data.denials && data.denials.length
          ? el(
              'div',
              {},
              ...data.denials.map((row) =>
                el(
                  'div',
                  { class: 'deny-row' },
                  el('span', { text: row.email || row.sub || 'unknown account' }),
                  el('span', { class: 'sub', text: `${absolute(row.ts)}${row.country ? ` · ${countryLabel(row.country)}` : ''}` }),
                ),
              ),
            )
          : el('p', { class: 'access-note', text: 'No one else has tried to open the dashboard.' }),
      ),
    ),
  )
}

async function load() {
  const query = `days=${state.days}`
  try {
    const [summary, breakdowns, visits, cloudflare, access] = await Promise.all([
      api(`/api/admin/summary?${query}`),
      api(`/api/admin/breakdowns?${query}`),
      api(`/api/admin/visits?${query}&limit=${state.limit}&offset=${state.offset}&bots=${state.bots ? 1 : 0}`),
      api(`/api/admin/cloudflare?days=${state.days || 30}`),
      api('/api/admin/access'),
    ])

    renderKpis(summary)
    renderChart(summary.daily || [])
    renderBreakdowns(breakdowns)
    renderVisits(visits)
    renderCloudflare(cloudflare)
    renderAccess(access)

    const stamp = new Date(summary.generatedAt)
    $('#updated').textContent = `Updated ${stamp.toLocaleTimeString()} · ${
      summary.days ? `last ${summary.days === 1 ? '24 hours' : `${summary.days} days`}` : 'all time'
    }${summary.firstDay ? ` · tracking since ${summary.firstDay}` : ''}`
    $('#export').href = `/api/admin/visits.csv?days=${state.days}&bots=${state.bots ? 1 : 0}`
    showError('')
  } catch (error) {
    if (error.status === 401) {
      showError('Your session expired. Reload the page to sign in again.')
    } else if (error.status === 403) {
      showError('This account is not allowed to view the dashboard.')
    } else {
      showError(error.message || 'Could not load dashboard data.')
    }
  }
}

function wire() {
  for (const button of document.querySelectorAll('.segmented button')) {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach((node) => node.classList.remove('active'))
      button.classList.add('active')
      state.days = Number(button.dataset.days)
      state.offset = 0
      load()
    })
  }

  $('#bots').addEventListener('change', (event) => {
    state.bots = event.target.checked
    state.offset = 0
    load()
  })

  $('#refresh').addEventListener('click', async () => {
    await load()
    toast('Refreshed')
  })

  $('#older').addEventListener('click', () => {
    state.offset += state.limit
    load()
  })

  $('#newer').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit)
    load()
  })

  setInterval(load, 60_000)
}

async function boot() {
  try {
    const session = await api('/auth/freebuff/session')
    if (session && session.user) {
      $('#who-name').textContent = session.user.name || 'Owner'
      $('#who-email').textContent = session.user.email || ''
      if (session.user.picture) {
        const avatar = $('#avatar')
        avatar.src = session.user.picture
        avatar.hidden = false
      }
    }
  } catch {
    // Display-only: the API still authorizes every request.
  }

  wire()
  load()
}

boot()
