// Optional bridge to the site's Cloudflare zone analytics.
//
// Set both CF_API_TOKEN (an API token with Zone -> Analytics -> Read) and
// CF_ZONE_ID as site secrets and this panel fills with Cloudflare's own
// numbers for the zone. Without them the dashboard shows first-party visits
// only, which needs no credentials.

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const ZONE_ID_PATTERN = /^[0-9a-f]{32}$/
const CACHE_MS = 5 * 60_000

let cache = { key: '', at: 0, value: null }

const QUERY = `query ZoneTraffic($zoneTag: String!, $start: Date!, $end: Date!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 60, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests pageViews bytes cachedRequests threats }
        uniq { uniques }
      }
    }
  }
}`

export async function cloudflareAnalytics(env, days = 30) {
  const token = env.CF_API_TOKEN
  const zoneId = String(env.CF_ZONE_ID || '').trim().toLowerCase()

  if (!token || !ZONE_ID_PATTERN.test(zoneId)) return { configured: false }

  const key = `${zoneId}:${days}:${token.slice(-6)}`
  if (cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.value
  }

  const end = new Date()
  const start = new Date(end.getTime() - Math.min(days, 30) * 86_400_000)
  const asDate = (date) => date.toISOString().slice(0, 10)

  let value
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { zoneTag: zoneId, start: asDate(start), end: asDate(end) },
      }),
    })
    const payload = await response.json()
    if (!response.ok || (payload.errors && payload.errors.length)) {
      const message = (payload.errors && payload.errors[0] && payload.errors[0].message) || `HTTP ${response.status}`
      value = { configured: true, ok: false, error: message }
    } else {
      const zones = (payload.data && payload.data.viewer && payload.data.viewer.zones) || []
      const groups = (zones[0] && zones[0].httpRequests1dGroups) || []
      const totals = groups.reduce(
        (acc, group) => {
          const sum = group.sum || {}
          acc.requests += sum.requests || 0
          acc.pageViews += sum.pageViews || 0
          acc.bytes += sum.bytes || 0
          acc.cachedRequests += sum.cachedRequests || 0
          acc.threats += sum.threats || 0
          acc.uniques += (group.uniq && group.uniq.uniques) || 0
          return acc
        },
        { requests: 0, pageViews: 0, bytes: 0, cachedRequests: 0, threats: 0, uniques: 0 },
      )
      value = {
        configured: true,
        ok: true,
        days: Math.min(days, 30),
        zoneId,
        totals,
        daily: groups.map((group) => ({
          day: group.dimensions && group.dimensions.date,
          requests: (group.sum && group.sum.requests) || 0,
          pageViews: (group.sum && group.sum.pageViews) || 0,
          uniques: (group.uniq && group.uniq.uniques) || 0,
        })),
        fetchedAt: new Date().toISOString(),
      }
    }
  } catch (error) {
    value = {
      configured: true,
      ok: false,
      error: (error && error.message) || 'Cloudflare request failed',
    }
  }

  cache = { key, at: Date.now(), value }
  return value
}
