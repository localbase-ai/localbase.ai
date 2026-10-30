import { useState, useEffect } from 'react'
import KpiCards from '@/components/KpiCards'
import TrendChart from '@/components/TrendChart'
import { loadMetrics } from '@/lib/dashboardMetrics'

// The workspace's landing view. What it shows comes from the workspace's
// dashboard.json (see lib/dashboardMetrics.js); sections get added here as we
// work out what belongs on it.

export default function Dashboard() {
  const [metrics, setMetrics] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadMetrics().then(setMetrics).catch(err => setError(err.message))
  }, [])

  let body
  if (error) {
    body = <p className="text-sm text-muted-foreground">Couldn't load the dashboard: {error}</p>
  } else if (!metrics) {
    body = <p className="text-sm text-muted-foreground">…</p>
  } else if (!metrics.length) {
    body = (
      <p className="text-sm text-muted-foreground">
        Nothing configured yet. Add a <code className="bg-card px-1 py-0.5 rounded">dashboard.json</code> to
        the workspace root to choose what shows here.
      </p>
    )
  } else {
    body = (
      <>
        <KpiCards metrics={metrics} />
        <TrendChart metrics={metrics} />
      </>
    )
  }

  return (
    <div className="px-4 pt-3 pb-6 space-y-4">
      <header>
        <h1 className="text-xl font-bold font-mono text-green-600 dark:text-green-400">
          ~/
        </h1>
      </header>
      {body}
    </div>
  )
}
