import { useState, useEffect } from 'react'
import { ArrowUp, ArrowDown } from 'lucide-react'
import { bucketQuery, latestQuery, runQuery, formatValue } from '@/lib/dashboardMetrics'

// One card per series with yesterday's number: the latest complete day, since
// today is always partial and most sources report with a lag. Compared with
// the average of the 7 days before it. Arrows show direction only, not
// good/bad: more ad spend isn't a win by itself.
//
// A dense source (one with rows every day) whose data stops before yesterday
// shows when it was last synced instead of a misleading zero.

const localIso = (d) => d.toLocaleDateString('en-CA') // YYYY-MM-DD in local time

function dayOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localIso(d)
}

const shortDate = (iso) => new Date(`${iso}T12:00:00`)
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

export default function KpiCards({ metrics = [] }) {
  const cards = metrics.flatMap(m => m.series.map(s => ({ ...s, format: m.format })))
  const [results, setResults] = useState({})
  const yesterday = dayOffset(-1)

  useEffect(() => {
    const start = dayOffset(-9)
    cards.filter(c => c.table).forEach(async (c) => {
      const lag = c.lagDays || 0
      const day = dayOffset(-1 - lag)
      try {
        const [rows, latestRows] = await Promise.all([
          runQuery(c.database, bucketQuery(c, 'day'), [start]),
          c.dense ? runQuery(c.database, latestQuery(c)) : Promise.resolve([]),
        ])
        const byDay = new Map(rows.map(r => [r.bucket, Number(r.value) || 0]))
        const latest = latestRows[0]?.latest || null
        const prior = Array.from({ length: 7 }, (_, i) => byDay.get(dayOffset(-2 - lag - i)) ?? 0)
        setResults(prev => ({
          ...prev,
          [c.id]: {
            day: lag ? day : null,
            value: byDay.get(day) ?? 0,
            avg: prior.reduce((a, b) => a + b, 0) / prior.length,
            stale: c.dense && (!latest || latest < day) ? latest : null,
          },
        }))
      } catch (err) {
        setResults(prev => ({ ...prev, [c.id]: { error: err.message } }))
      }
    })
  }, [])

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">Yesterday · {shortDate(yesterday)}</p>
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
        {cards.map(c => <Card key={c.id} card={c} result={results[c.id]} />)}
      </div>
    </div>
  )
}

function Card({ card, result }) {
  let body
  if (!card.table) {
    body = <p className="text-sm text-muted-foreground italic mt-1.5">not connected</p>
  } else if (!result) {
    body = <p className="text-sm text-muted-foreground mt-2">…</p>
  } else if (result.error) {
    body = <p className="text-sm text-muted-foreground italic mt-2">error</p>
  } else if (result.stale !== null && result.stale !== undefined) {
    body = (
      <>
        <p className="text-xl font-mono text-muted-foreground mt-0.5">—</p>
        <p className="text-xs text-muted-foreground mt-1">
          Last synced data: {result.stale ? shortDate(result.stale) : 'none'}
        </p>
      </>
    )
  } else {
    const { value, avg } = result
    const delta = avg > 0 ? (value - avg) / avg : null
    const Arrow = delta > 0 ? ArrowUp : ArrowDown
    body = (
      <>
        <p className="text-xl font-mono mt-0.5">{formatValue(value, card.format)}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 whitespace-nowrap">
          {delta !== null && Math.abs(delta) >= 0.005 && <Arrow className="h-3 w-3" />}
          {delta === null ? 'none prior 7 days'
            : `${Math.abs(delta * 100).toFixed(0)}% vs avg ${formatValue(avg, card.format, true)}`}
        </p>
        {result.day && <p className="text-xs text-muted-foreground">{shortDate(result.day)} (reporting lag)</p>}
      </>
    )
  }

  return (
    <div className={`rounded-lg border border-border px-3 py-2.5 min-w-0 ${card.table ? 'bg-card' : 'bg-muted/60'}`}>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-0.5 shrink-0" style={{ background: card.color }} />
        <p className="text-xs text-muted-foreground truncate">{card.card}</p>
      </div>
      {body}
    </div>
  )
}
