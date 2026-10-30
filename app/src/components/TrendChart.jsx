import { useState, useEffect, useRef } from 'react'
import { bucketQuery, runQuery, formatValue, isoDate } from '@/lib/dashboardMetrics'

// Weekly trends for the dashboard: one row per metric, all on the same weekly
// time axis, with a shared hover line. Metrics have different units (dollars,
// calls, sessions), so each row gets its own y-scale rather than sharing one.
//
// Data comes live from the workspace's connector databases through the
// read-only /api/db/query endpoint. A series with no `table` is shown as not
// connected; a series with `since` is drawn only from the date its tracking
// started, so missing history doesn't read as zero.

const ROW_HEIGHT = 112
const MARGIN = { top: 8, right: 16, bottom: 6, left: 56 }
const AXIS_HEIGHT = 22

function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d
}

// Monday-start weeks from `weeks` complete weeks ago up to last week; the
// current, partial week is left out so the right edge doesn't dip.
function weekStarts(weeks) {
  const lastWeek = mondayOf(new Date())
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7)
  const out = []
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(lastWeek)
    d.setUTCDate(d.getUTCDate() - 7 * i)
    out.push(isoDate(d))
  }
  return out
}

function niceMax(max) {
  if (!max || max <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 2.5, 5, 10].map(s => s * pow).find(v => v >= max)
}

const weekLabel = (wk) => new Date(`${wk}T00:00:00Z`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function TrendChart({ metrics = [], weeks = 104 }) {
  const [weekList] = useState(() => weekStarts(weeks))
  const [data, setData] = useState({})     // seriesId -> array aligned to weekList (null = no data)
  const [errors, setErrors] = useState({}) // seriesId -> message
  const [hover, setHover] = useState(null) // index into weekList
  const [showTable, setShowTable] = useState(false)
  const [width, setWidth] = useState(800)
  const wrapRef = useRef(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const start = weekList[0]
    const end = weekList[weekList.length - 1]
    metrics.flatMap(m => m.series).filter(s => s.table).forEach(async (s) => {
      try {
        const rows = await runQuery(s.database, bucketQuery(s, 'week'), [start])
        const byWeek = new Map(rows.map(r => [r.bucket, Number(r.value) || 0]))
        const values = weekList.map(wk => {
          if (s.since && wk < mondayOf(new Date(`${s.since}T00:00:00Z`)).toISOString().slice(0, 10)) return null
          if (wk > end) return null
          return byWeek.get(wk) ?? 0
        })
        setData(prev => ({ ...prev, [s.id]: values }))
      } catch (err) {
        setErrors(prev => ({ ...prev, [s.id]: err.message }))
      }
    })
  }, [metrics, weekList])

  const plotW = width - MARGIN.left - MARGIN.right
  const x = (i) => MARGIN.left + (weekList.length > 1 ? (i / (weekList.length - 1)) * plotW : 0)

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left - MARGIN.left
    const i = Math.round((px / plotW) * (weekList.length - 1))
    setHover(Math.min(weekList.length - 1, Math.max(0, i)))
  }

  const readIndex = hover ?? weekList.length - 1

  // Month ticks: first week of every third month
  const ticks = weekList
    .map((wk, i) => ({ wk, i }))
    .filter(({ wk, i }) => {
      const prev = weekList[i - 1]
      const m = Number(wk.slice(5, 7))
      return (!prev || prev.slice(5, 7) !== wk.slice(5, 7)) && (m - 1) % 3 === 0
    })

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Weekly trends</h2>
          <p className="text-xs text-muted-foreground">
            {hover == null ? 'Last full week' : 'Week of'} {weekLabel(weekList[readIndex])} · last {weeks} weeks
          </p>
        </div>
        <button
          onClick={() => setShowTable(v => !v)}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      <div ref={wrapRef} className="w-full">
        {showTable ? (
          <TrendTable metrics={metrics} weekList={weekList} data={data} />
        ) : metrics.map((m, mi) => {
          const series = m.series
          const values = series.flatMap(s => data[s.id] || []).filter(v => v != null)
          const yMax = niceMax(Math.max(0, ...values))
          const plotH = ROW_HEIGHT - MARGIN.top - MARGIN.bottom
          const y = (v) => MARGIN.top + plotH - (v / yMax) * plotH
          const isLast = mi === metrics.length - 1
          const svgH = ROW_HEIGHT + (isLast ? AXIS_HEIGHT : 0)

          return (
            <div key={m.id} className={mi > 0 ? 'border-t border-border/60' : ''}>
              <div className="px-4 pt-3 flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  {m.icon && <m.icon className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5 text-muted-foreground" />}
                  <span className={`text-sm font-medium ${series.every(s => !s.table) ? 'text-muted-foreground' : ''}`}>{m.title}</span>
                  {m.note && <span className="ml-2 text-xs text-muted-foreground">{m.note}</span>}
                </div>
                <div className="flex items-baseline gap-4 shrink-0">
                  {series.map(s => {
                    const v = data[s.id]?.[readIndex]
                    return (
                      <span key={s.id} className="flex items-baseline gap-1.5 text-xs">
                        {series.length > 1 && (
                          <span className="inline-block w-2.5 h-0.5 self-center" style={{ background: s.color }} />
                        )}
                        {series.length > 1 && <span className="text-muted-foreground">{s.label}</span>}
                        {!s.table || errors[s.id] ? (
                          <span className="text-muted-foreground italic">
                            {!s.table ? 'not connected' : 'error'}
                          </span>
                        ) : (
                          <span className="font-mono text-sm text-foreground">{formatValue(v, m.format)}</span>
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>

              {series.every(s => !s.table) ? (
                <div className="mx-4 my-3 rounded bg-muted/60 text-xs text-muted-foreground flex items-center justify-center"
                  style={{ height: ROW_HEIGHT - 24, marginLeft: MARGIN.left, marginRight: MARGIN.right }}>
                  Not connected yet{m.note ? ` · ${m.note}` : ''}
                </div>
              ) : (
              <svg width={width} height={svgH} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
                {[0, 0.5, 1].map(f => (
                  <g key={f}>
                    <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(yMax * f)} y2={y(yMax * f)}
                      stroke="currentColor" className="text-border" strokeWidth={1} />
                    <text x={MARGIN.left - 8} y={y(yMax * f)} dy="0.32em" textAnchor="end"
                      className="fill-muted-foreground font-mono" fontSize={10}>
                      {formatValue(yMax * f, m.format, true)}
                    </text>
                  </g>
                ))}

                {series.map(s => {
                  const vals = data[s.id]
                  if (!vals) return null
                  let d = ''
                  vals.forEach((v, i) => {
                    if (v == null) return
                    d += `${d && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
                  })
                  return <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
                })}

                {hover != null && (
                  <>
                    <line x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={ROW_HEIGHT - MARGIN.bottom}
                      stroke="currentColor" className="text-muted-foreground" strokeWidth={1} />
                    {series.map(s => {
                      const v = data[s.id]?.[hover]
                      return v == null ? null : (
                        <circle key={s.id} cx={x(hover)} cy={y(v)} r={4}
                          fill={s.color} stroke="hsl(var(--card))" strokeWidth={2} />
                      )
                    })}
                  </>
                )}

                {isLast && ticks.map(({ wk, i }) => (
                  <text key={wk} x={x(i)} y={ROW_HEIGHT + 14} textAnchor="middle"
                    className="fill-muted-foreground font-mono" fontSize={10}>
                    {new Date(`${wk}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })}
                  </text>
                ))}
              </svg>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TrendTable({ metrics, weekList, data }) {
  const cols = metrics.flatMap(m => m.series.map(s => ({ m, s })))
  return (
    <div className="max-h-[560px] overflow-auto">
      <table className="w-full text-xs font-mono">
        <thead className="sticky top-0 bg-card">
          <tr className="text-muted-foreground">
            <th className="text-left font-normal px-4 py-2">Week of</th>
            {cols.map(({ m, s }) => (
              <th key={s.id} className="text-right font-normal px-4 py-2">
                {m.series.length > 1 ? `${m.title}: ${s.label}` : m.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...weekList].reverse().map((wk) => {
            const i = weekList.indexOf(wk)
            return (
              <tr key={wk} className="border-t border-border/60">
                <td className="px-4 py-1.5">{wk}</td>
                {cols.map(({ m, s }) => (
                  <td key={s.id} className="text-right px-4 py-1.5">
                    {s.table ? formatValue(data[s.id]?.[i], m.format) : '—'}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
