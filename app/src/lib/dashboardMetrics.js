// What the dashboard shows, defined once for both the KPI cards and the weekly
// trend chart. The definitions are workspace config: `dashboard.json` at the
// instance root, served by GET /api/dashboard. Each series names a table in a
// workspace connector database; `bucketQuery` turns that into a grouped query
// by day or week, run through the read-only /api/db/query endpoint.
//
// dashboard.json:
//   { "metrics": [
//       { "id": "calls", "title": "Phone calls", "icon": "phone", "format": "int",
//         "note": "optional subtitle",
//         "series": [
//           { "id": "calls", "label": "Calls", "card": "Phone calls", "color": "aqua",
//             "database": "data/<connector>/<name>.db", "table": "<table>",
//             "value": "SUM(calls)",          // aggregate per bucket
//             "date": "date",                 // date column (default "date")
//             "where": "…",                   // optional SQL filter
//             "dense": true,                  // a row every day: a gap means a stale sync
//             "lagDays": 1,                   // source reports a day late
//             "since": "2025-01-01" } ] } ] } // tracking started then; earlier isn't zero
// A series without `table` shows as "not connected". No file, no metrics: the
// dashboard says so instead of guessing.

import {
  Phone, Store, MousePointerClick, ShoppingCart, ClipboardList, DollarSign,
  Users, Mail, Calendar, Star, Eye, TrendingUp, Activity,
} from 'lucide-react'

// Categorical slots 1-3 of the dataviz reference palette, as theme tokens in
// index.css so light and dark mode each get their own validated steps.
export const COLOR = { blue: 'var(--series-blue)', orange: 'var(--series-orange)', aqua: 'var(--series-aqua)' }

// Icons a config may name. Unknown names fall back to a generic one.
const ICONS = {
  phone: Phone, store: Store, click: MousePointerClick, cart: ShoppingCart, form: ClipboardList,
  dollar: DollarSign, users: Users, mail: Mail, calendar: Calendar, star: Star, eye: Eye,
  trend: TrendingUp, activity: Activity,
}

/** Fetch the workspace's dashboard config and resolve icon and color names. */
export async function loadMetrics() {
  const res = await fetch('/api/dashboard')
  const json = await res.json()
  if (!json.success) throw new Error(json.error || 'could not load dashboard.json')
  return (json.metrics || []).map(m => ({
    ...m,
    icon: ICONS[m.icon] || Activity,
    series: (m.series || []).map(s => ({ ...s, color: COLOR[s.color] || s.color || COLOR.aqua })),
  }))
}

export const BUCKET = {
  day: (col) => `date(${col})`,
  week: (col) => `date(${col}, '-6 days', 'weekday 1')`,
}

/** Grouped query for one series: rows of { bucket, value } from `start` on. */
export function bucketQuery(series, bucket) {
  const col = series.date || 'date'
  return `SELECT ${BUCKET[bucket](col)} AS bucket, ${series.value} AS value
          FROM ${series.table}
          WHERE ${col} >= ?${series.where ? ` AND ${series.where}` : ''}
          GROUP BY bucket`
}

/** Latest date the series has any row for (how far its last sync reaches). */
export function latestQuery(series) {
  const col = series.date || 'date'
  return `SELECT MAX(date(${col})) AS latest FROM ${series.table}`
}

export async function runQuery(database, sql, params = []) {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ database, sql, params }),
  })
  const json = await res.json()
  if (!json.success) throw new Error(json.error || 'query failed')
  return json.data || []
}

export function formatValue(v, format, compact = false) {
  if (v == null) return '—'
  if (format === 'usd') {
    if (compact && v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
    return `$${Math.round(v).toLocaleString('en-US')}`
  }
  if (compact && v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (compact && !Number.isInteger(v) && v < 10) return v.toFixed(1)
  return Math.round(v).toLocaleString('en-US')
}

export const isoDate = (d) => d.toISOString().slice(0, 10)
