import { useState, useEffect } from 'react'
import { Database, Loader2, FolderOpen, RefreshCw, Check, X, Edit, Save, Plus, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Setup from '@/components/Setup'

function ConnectorLogo({ id, className = 'h-5 w-5' }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <Database className={`${className} text-green-400`} />
  }
  return (
    <img
      src={`/api/connectors/${id}/logo`}
      alt=""
      className={`${className} object-contain`}
      onError={() => setFailed(true)}
    />
  )
}

// Helper function to get sync status color based on date
function getSyncStatusColor(lastSyncDate) {
  if (!lastSyncDate || lastSyncDate === 'Unknown') return 'text-muted-foreground'

  try {
    // Parse YYYY-MM-DD format to avoid timezone issues
    const [year, month, day] = lastSyncDate.split('-').map(Number)
    const syncDate = new Date(year, month - 1, day)

    const today = new Date()
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const diffTime = todayDate - syncDate
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

    if (diffDays <= 0) return 'text-green-400' // Today or future
    if (diffDays <= 7) return 'text-yellow-400' // Within last week
    return 'text-red-400' // Older than 7 days
  } catch {
    return 'text-muted-foreground'
  }
}

// Helper function to get sort priority (stoplight order: green, yellow, red, unknown)
function getSyncSortPriority(lastSyncDate) {
  if (!lastSyncDate || lastSyncDate === 'Unknown') return 4 // Unknown goes last

  try {
    const [year, month, day] = lastSyncDate.split('-').map(Number)
    const syncDate = new Date(year, month - 1, day)
    const today = new Date()
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const diffTime = todayDate - syncDate
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

    if (diffDays <= 0) return 1 // Green - today
    if (diffDays <= 7) return 2 // Yellow - within last week
    return 3 // Red - older than 7 days
  } catch {
    return 4 // Unknown
  }
}

export default function Overview({ onNavigateHome }) {
  const [expressStatus, setExpressStatus] = useState('checking')
  const [mcpStatus, setMcpStatus] = useState('running') // MCP runs in Electron process
  const [databaseMode, setDatabaseMode] = useState(null) // 'cloud' or 'local'
  const [databaseUrl, setDatabaseUrl] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [showingSetup, setShowingSetup] = useState(false)
  const [connectors, setConnectors] = useState([])
  const [connectorsLoading, setConnectorsLoading] = useState(true)
  const [visualizations, setVisualizations] = useState([])
  const [dataSources, setDataSources] = useState([])
  const [dataSourcesLoading, setDataSourcesLoading] = useState(true)
  const [forceSingleWorkspace, setForceSingleWorkspace] = useState(() => {
    return localStorage.getItem('localbase-force-single-workspace') === 'true'
  })
  const [syncingSource, setSyncingSource] = useState(null) // Track which source is syncing
  const [syncStatus, setSyncStatus] = useState({}) // Track sync status per source: { sourceId: 'success'|'error' }
  const [editingDatabase, setEditingDatabase] = useState(false)
  const [supabaseUrl, setSupabaseUrl] = useState('')
  const [supabaseKey, setSupabaseKey] = useState('')
  const [savingDatabase, setSavingDatabase] = useState(false)
  const [showAddConnector, setShowAddConnector] = useState(false)
  const [installingConnector, setInstallingConnector] = useState(null)
  const [configuringConnector, setConfiguringConnector] = useState(null)
  const [connectorCredentials, setConnectorCredentials] = useState({})
  const [savingCredentials, setSavingCredentials] = useState(false)

  // Load project root on mount
  useEffect(() => {
    if (window.electronAPI?.config) {
      window.electronAPI.config.getProjectRoot().then(root => {
        setProjectRoot(root)
      })
    }
  }, [])

  // Check database mode and load Supabase config
  useEffect(() => {
    const checkDatabaseMode = async () => {
      try {
        // Get Supabase config from main process
        if (window.electronAPI?.config?.getSupabaseConfig) {
          const config = await window.electronAPI.config.getSupabaseConfig()

          if (config && config.url && config.key) {
            setDatabaseMode('cloud')
            // Extract short URL (remove https://)
            const shortUrl = config.url.replace('https://', '')
            setDatabaseUrl(shortUrl)
            // Pre-populate edit fields
            setSupabaseUrl(config.url)
            setSupabaseKey(config.key)
          } else {
            setDatabaseMode('local')
            setDatabaseUrl('Local SQLite')
          }
        } else {
          // Fallback: try a query to detect
          const result = await window.electronAPI.db.query('SELECT 1 as test', [])
          setDatabaseMode('cloud')
          setDatabaseUrl('Supabase PostgreSQL')
        }
      } catch (error) {
        setDatabaseMode('local')
        setDatabaseUrl('Local SQLite')
      }
    }

    if (projectRoot) {
      checkDatabaseMode()
    }
  }, [projectRoot])

  // Load workspace data (connectors, visualizations, data sources)
  useEffect(() => {
    const loadWorkspaceData = async () => {
      if (!projectRoot) return

      // Load connectors
      if (window.electronAPI?.api?.getConnectors) {
        setConnectorsLoading(true)
        try {
          const result = await window.electronAPI.api.getConnectors()
          if (result.success) {
            setConnectors(result.connectors || [])
          } else {
            console.error('Failed to load connectors:', result.error)
            setConnectors([])
          }
        } catch (error) {
          console.error('Error loading connectors:', error)
          setConnectors([])
        } finally {
          setConnectorsLoading(false)
        }
      }

      // Load data sources from local runtime config or example config
      if (window.electronAPI?.api?.getDataSources) {
        setDataSourcesLoading(true)
        try {
          const result = await window.electronAPI.api.getDataSources()
          if (result.success && result.sources) {
            // Convert sources object to array with id
            const sourcesArray = Object.entries(result.sources).map(([id, data]) => ({
              id,
              ...data
            }))

            // Sort by: 1) automated first, 2) stoplight order (green, yellow, red)
            sourcesArray.sort((a, b) => {
              // Automated sources always on top
              if (a.type === 'automated' && b.type !== 'automated') return -1
              if (a.type !== 'automated' && b.type === 'automated') return 1

              // Within same type, sort by sync freshness (green, yellow, red)
              const aPriority = getSyncSortPriority(a.last_sync)
              const bPriority = getSyncSortPriority(b.last_sync)
              return aPriority - bPriority
            })

            setDataSources(sourcesArray)
          } else {
            setDataSources([])
          }
        } catch (error) {
          console.error('Error loading data sources:', error)
          setDataSources([])
        } finally {
          setDataSourcesLoading(false)
        }
      }

      // Load visualizations
      if (window.electronAPI?.api?.getVisualizations) {
        try {
          const result = await window.electronAPI.api.getVisualizations()
          setVisualizations(result.visualizations || [])
        } catch (error) {
          console.error('Error loading visualizations:', error)
          setVisualizations([])
        }
      }
    }

    loadWorkspaceData()
  }, [projectRoot])

  // No longer need HTTP server health check - using direct IPC
  useEffect(() => {
    setExpressStatus('running')
  }, [])

  const handleChangeProject = () => {
    setShowingSetup(true)
  }

  const handleSetupComplete = () => {
    setShowingSetup(false)
    // Reload UI to show new project path
    // Backend servers will hot-reload automatically
    window.location.reload()
  }

  const handleToggleSingleWorkspace = (enabled) => {
    setForceSingleWorkspace(enabled)
    localStorage.setItem('localbase-force-single-workspace', enabled.toString())
    // Dispatch event so other components can react
    window.dispatchEvent(new CustomEvent('single-workspace-mode-changed', { detail: enabled }))
  }

  const handleSyncSource = async (sourceId) => {
    setSyncingSource(sourceId)
    setSyncStatus(prev => ({ ...prev, [sourceId]: null })) // Clear previous status

    try {
      if (window.electronAPI?.api?.syncDataSource) {
        const result = await window.electronAPI.api.syncDataSource(sourceId)

        if (result.success) {
          setSyncStatus(prev => ({ ...prev, [sourceId]: 'success' }))
          // Reload data sources to show updated timestamp
          setTimeout(async () => {
            if (window.electronAPI?.api?.getDataSources) {
              const sourcesResult = await window.electronAPI.api.getDataSources()
              if (sourcesResult.success && sourcesResult.sources) {
                const sourcesArray = Object.entries(sourcesResult.sources).map(([id, data]) => ({
                  id,
                  ...data
                }))

                // Sort by: 1) automated first, 2) stoplight order (green, yellow, red)
                sourcesArray.sort((a, b) => {
                  // Automated sources always on top
                  if (a.type === 'automated' && b.type !== 'automated') return -1
                  if (a.type !== 'automated' && b.type === 'automated') return 1

                  // Within same type, sort by sync freshness (green, yellow, red)
                  const aPriority = getSyncSortPriority(a.last_sync)
                  const bPriority = getSyncSortPriority(b.last_sync)
                  return aPriority - bPriority
                })

                setDataSources(sourcesArray)
              }
            }
          }, 500)
        } else {
          console.error(`Sync failed for ${sourceId}:`, result.error, result.output)
          setSyncStatus(prev => ({ ...prev, [sourceId]: 'error' }))
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      setSyncStatus(prev => ({ ...prev, [sourceId]: 'error' }))
    } finally {
      setSyncingSource(null)
      // Clear status after 5 seconds (was 3, give more time to read)
      setTimeout(() => {
        setSyncStatus(prev => ({ ...prev, [sourceId]: null }))
      }, 5000)
    }
  }

  // Available connector templates
  const availableConnectors = [
    {
      id: 'hubspot',
      name: 'HubSpot',
      description: 'CRM, contacts, deals, and meetings',
      icon: '🟠',
      authType: 'api-key',
      envVars: ['HUBSPOT_ACCESS_TOKEN'],
      docsUrl: 'https://developers.hubspot.com/docs/api/private-apps'
    },
    {
      id: 'quickbooks',
      name: 'QuickBooks',
      description: 'Invoices, customers, and financial data',
      icon: '💚',
      authType: 'oauth',
      oauthUrl: 'https://benevolent-malabi-37c3f8.netlify.app/.netlify/functions/oauth',
      envVars: ['QUICKBOOKS_ACCESS_TOKEN', 'QUICKBOOKS_REFRESH_TOKEN', 'QUICKBOOKS_COMPANY_ID'],
      docsUrl: 'https://developer.intuit.com/'
    }
  ]

  const handleConfigureConnector = (connector) => {
    // Initialize credentials state for this connector
    const template = availableConnectors.find(c => c.id === connector.id)
    if (template) {
      const initialCreds = {}
      template.envVars.forEach(v => initialCreds[v] = '')
      setConnectorCredentials(initialCreds)
    }
    setConfiguringConnector(connector)
  }

  const handleSaveCredentials = async () => {
    setSavingCredentials(true)
    try {
      const result = await fetch('/api/env/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: connectorCredentials })
      }).then(r => r.json())

      if (result.success) {
        setConfiguringConnector(null)
        setConnectorCredentials({})
        // Refresh connectors to show updated status
        if (window.electronAPI?.api?.getConnectors) {
          const connectorsResult = await window.electronAPI.api.getConnectors()
          if (connectorsResult.success) {
            setConnectors(connectorsResult.connectors || [])
          }
        }
      } else {
        alert(`Failed to save credentials: ${result.error}`)
      }
    } catch (error) {
      console.error('Error saving credentials:', error)
      alert(`Error saving credentials: ${error.message}`)
    } finally {
      setSavingCredentials(false)
    }
  }

  const handleInstallConnector = async (connectorId) => {
    setInstallingConnector(connectorId)
    try {
      const result = await fetch('/api/connectors/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId })
      }).then(r => r.json())

      if (result.success) {
        // Refresh connectors list
        if (window.electronAPI?.api?.getConnectors) {
          const connectorsResult = await window.electronAPI.api.getConnectors()
          if (connectorsResult.success) {
            setConnectors(connectorsResult.connectors || [])
          }
        }
        setShowAddConnector(false)
      } else {
        alert(`Failed to install connector: ${result.error}`)
      }
    } catch (error) {
      console.error('Error installing connector:', error)
      alert(`Error installing connector: ${error.message}`)
    } finally {
      setInstallingConnector(null)
    }
  }

  // Show setup modal when changing project
  if (showingSetup) {
    return (
      <div className="fixed inset-0 bg-background z-50">
        <Setup onComplete={handleSetupComplete} />
      </div>
    )
  }

  // Show empty state if no workspace selected
  if (!projectRoot) {
    return (
      <div className="p-8 space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold font-mono text-green-400">
            LocalBase Desktop
          </h1>
          <p className="text-muted-foreground">
            Manage your local data infrastructure
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>No Workspace Selected</CardTitle>
            <CardDescription>
              Select a workspace from the Home view to see settings and connectors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => onNavigateHome?.()}
              className="border-green-400/50 text-green-400 hover:bg-green-400/10"
            >
              <FolderOpen className="h-4 w-4 mr-2" />
              Go to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold font-mono text-green-400">
          LocalBase Desktop
        </h1>
        <p className="text-muted-foreground">
          Manage your local data infrastructure
        </p>
      </div>

      {/* Add Connector Modal */}
      {showAddConnector && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-lg mx-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5 text-green-400" />
                Add Connector
              </CardTitle>
              <CardDescription>
                Select a connector to install in your workspace
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {availableConnectors.map((connector) => {
                const isInstalled = connectors.some(c => c.id === connector.id)
                return (
                  <div
                    key={connector.id}
                    className={`p-4 border rounded-lg transition-all ${
                      isInstalled
                        ? 'border-green-400/30 bg-green-400/5'
                        : 'border-border hover:border-green-400/50'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">{connector.icon}</span>
                        <div>
                          <h3 className="font-medium">{connector.name}</h3>
                          <p className="text-sm text-muted-foreground">{connector.description}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <a
                              href={connector.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-green-400 hover:underline flex items-center gap-1"
                            >
                              <ExternalLink className="h-3 w-3" />
                              API Docs
                            </a>
                          </div>
                        </div>
                      </div>
                      <div>
                        {isInstalled ? (
                          <span className="text-xs text-green-400 flex items-center gap-1">
                            <Check className="h-3 w-3" />
                            Installed
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleInstallConnector(connector.id)}
                            disabled={installingConnector === connector.id}
                            className="bg-green-400 text-black hover:bg-green-500"
                          >
                            {installingConnector === connector.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              'Install'
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                    {!isInstalled && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <p className="text-xs text-muted-foreground mb-1">Required env vars:</p>
                        <div className="flex flex-wrap gap-1">
                          {connector.envVars.map(v => (
                            <code key={v} className="text-xs bg-muted px-1.5 py-0.5 rounded">{v}</code>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
            <div className="p-4 pt-0">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowAddConnector(false)}
              >
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Connectors */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Active Connectors</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAddConnector(true)}
            className="border-green-400/50 text-green-400 hover:bg-green-400/10"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Connector
          </Button>
        </div>

        {connectorsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-green-400" />
          </div>
        ) : connectors.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No connectors found in this workspace</p>
              <p className="text-sm text-muted-foreground mt-2">
                Add connectors to the <code className="bg-muted px-1 py-0.5 rounded">connectors/</code> directory
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {connectors
              .sort((a, b) => {
                // Sort order: active (1), missing-index (2), needs-fix (3)
                const statusPriority = {
                  'active': 1,
                  'missing-index': 2,
                  'needs-fix': 3
                }
                return (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99)
              })
              .map((connector) => (
              <Card key={connector.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ConnectorLogo id={connector.id} />
                    {connector.name}
                  </CardTitle>
                  <CardDescription>{connector.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      Last sync: {connector.lastSync}
                    </span>
                    <div className="flex items-center gap-3">
                      {connector.status === 'needs-fix' && availableConnectors.some(c => c.id === connector.id) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleConfigureConnector(connector)}
                          className="h-7 text-xs border-green-400/50 text-green-400 hover:bg-green-400/10"
                        >
                          Configure
                        </Button>
                      )}
                      <div className="flex items-center gap-2">
                        <div className={`h-2 w-2 rounded-full ${
                          connector.status === 'active' ? 'bg-green-400' :
                          connector.status === 'missing-index' ? 'bg-orange-400' :
                          'bg-red-400'
                        }`} />
                        <span className={`text-xs ${
                          connector.status === 'active' ? 'text-green-400' :
                          connector.status === 'missing-index' ? 'text-orange-400' :
                          'text-red-400'
                        }`}>
                          {connector.status === 'active' ? 'Active' :
                           connector.status === 'missing-index' ? 'Missing index.js' :
                           'Needs Fix'}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Configure Connector Modal */}
      {configuringConnector && (() => {
        const template = availableConnectors.find(c => c.id === configuringConnector.id)
        if (!template) return null
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="w-full max-w-lg mx-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="text-2xl">{template.icon}</span>
                  Configure {template.name}
                </CardTitle>
                <CardDescription>
                  Follow these steps to connect your {template.name} account
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {template.authType === 'oauth' ? (
                  /* OAuth Flow (QuickBooks) */
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-green-400 text-black flex items-center justify-center text-sm font-bold">1</div>
                        <h3 className="font-medium">Connect to {template.name}</h3>
                      </div>
                      <div className="ml-8 space-y-3">
                        <p className="text-sm text-muted-foreground">
                          Click the button below to connect your {template.name} account. You'll be redirected to {template.name} to authorize access.
                        </p>
                        <Button
                          onClick={() => window.open(template.oauthUrl, '_blank')}
                          className="bg-green-400 text-black hover:bg-green-500"
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Connect to {template.name}
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-green-400 text-black flex items-center justify-center text-sm font-bold">2</div>
                        <h3 className="font-medium">Paste your credentials</h3>
                      </div>
                      <div className="ml-8 space-y-3">
                        <p className="text-sm text-muted-foreground">
                          After authorizing, copy the credentials and paste them below:
                        </p>
                        {template.envVars.map(varName => (
                          <div key={varName} className="space-y-1">
                            <Label htmlFor={varName} className="text-xs font-mono">{varName}</Label>
                            <Input
                              id={varName}
                              type="password"
                              placeholder="••••••••"
                              value={connectorCredentials[varName] || ''}
                              onChange={(e) => setConnectorCredentials(prev => ({
                                ...prev,
                                [varName]: e.target.value
                              }))}
                              className="font-mono text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  /* API Key Flow (HubSpot) */
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-green-400 text-black flex items-center justify-center text-sm font-bold">1</div>
                        <h3 className="font-medium">Create a Private App in {template.name}</h3>
                      </div>
                      <div className="ml-8 space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Go to Settings → Integrations → Private Apps → Create private app. Name it <code className="bg-muted px-1 py-0.5 rounded">LocalBase</code> and upload <code className="bg-muted px-1 py-0.5 rounded">icon-256.png</code> from your app/public folder
                        </p>
                        <a
                          href={template.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-green-400 hover:underline flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View API Documentation
                        </a>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-green-400 text-black flex items-center justify-center text-sm font-bold">2</div>
                        <h3 className="font-medium">Grant required scopes</h3>
                      </div>
                      <div className="ml-8">
                        <p className="text-sm text-muted-foreground">
                          Enable read access for: crm.objects.contacts, crm.objects.deals, crm.objects.companies
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-green-400 text-black flex items-center justify-center text-sm font-bold">3</div>
                        <h3 className="font-medium">Enter your credentials</h3>
                      </div>
                      <div className="ml-8 space-y-3">
                        {template.envVars.map(varName => (
                          <div key={varName} className="space-y-1">
                            <Label htmlFor={varName} className="text-xs font-mono">{varName}</Label>
                            <Input
                              id={varName}
                              type="password"
                              placeholder={varName === 'HUBSPOT_ACCESS_TOKEN' ? 'pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : '••••••••'}
                              value={connectorCredentials[varName] || ''}
                              onChange={(e) => setConnectorCredentials(prev => ({
                                ...prev,
                                [varName]: e.target.value
                              }))}
                              className="font-mono text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
              <div className="p-4 pt-0 flex gap-2">
                <Button
                  onClick={handleSaveCredentials}
                  disabled={savingCredentials || Object.values(connectorCredentials).some(v => !v)}
                  className="flex-1 bg-green-400 text-black hover:bg-green-500"
                >
                  {savingCredentials ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Save Credentials
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfiguringConnector(null)
                    setConnectorCredentials({})
                  }}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          </div>
        )
      })()}

      {/* Data Sources */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Data Sources</h2>
        </div>

        {dataSourcesLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-green-400" />
          </div>
        ) : dataSources.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No data sources configured</p>
              <p className="text-sm text-muted-foreground mt-2">
                Create <code className="bg-muted px-1 py-0.5 rounded">data/data-sources.local.json</code> or copy <code className="bg-muted px-1 py-0.5 rounded">data/data-sources.example.json</code>
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {dataSources
                  .sort((a, b) => {
                    // Automated sources first, then manual
                    if (a.type === 'automated' && b.type !== 'automated') return -1
                    if (a.type !== 'automated' && b.type === 'automated') return 1
                    return 0
                  })
                  .map((source) => (
                  <div key={source.id} className="p-4 hover:bg-muted/5 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Database className="h-4 w-4 text-green-400 flex-shrink-0" />
                          <h3 className="font-medium truncate">{source.name}</h3>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="text-xs">
                            {source.type === 'automated' ? '🤖 Automated' : '📝 Manual'}
                          </span>
                          {source.data?.records && (
                            <span className="font-mono text-xs">
                              {source.data.records.toLocaleString()} records
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0 text-right">
                          <div className={`text-sm font-medium ${
                            syncStatus[source.id] === 'success'
                              ? 'text-green-400'
                              : syncStatus[source.id] === 'error'
                              ? 'text-red-400'
                              : getSyncStatusColor(source.last_sync)
                          }`}>
                            {source.last_sync || 'Unknown'}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Last sync
                          </div>
                        </div>
                        {source.type === 'automated' && (
                          <button
                            onClick={() => handleSyncSource(source.id)}
                            disabled={syncingSource === source.id}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                              syncStatus[source.id] === 'success'
                                ? 'bg-green-400/20 text-green-400'
                                : syncStatus[source.id] === 'error'
                                ? 'bg-red-400/20 text-red-400'
                                : 'hover:bg-muted'
                            }`}
                          >
                            {syncingSource === source.id ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                <span>Syncing...</span>
                              </>
                            ) : syncStatus[source.id] === 'success' ? (
                              <>
                                <Check className="h-3 w-3" />
                                <span>Synced</span>
                              </>
                            ) : syncStatus[source.id] === 'error' ? (
                              <>
                                <X className="h-3 w-3" />
                                <span>Error</span>
                              </>
                            ) : (
                              <>
                                <RefreshCw className="h-3 w-3" />
                                <span>Sync</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Project Configuration */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Project Configuration</h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Working Directory</CardTitle>
            <CardDescription>LocalBase project root location</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <code className="text-sm bg-muted px-3 py-2 rounded font-mono text-green-400 flex-1 mr-4">
                  {projectRoot || 'Loading...'}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangeProject}
                  className="border-green-400/50 text-green-400 hover:bg-green-400/10"
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Change
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This directory contains your connectors/, data/, and env.local
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Force Single Workspace Mode</CardTitle>
            <CardDescription>Simulate single-workspace user experience for testing</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm">When enabled, workspace switcher is hidden</p>
                <p className="text-xs text-muted-foreground">
                  Useful for testing the app as a single-workspace user would experience it
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer ml-4">
                <input
                  type="checkbox"
                  checked={forceSingleWorkspace}
                  onChange={(e) => handleToggleSingleWorkspace(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-green-400/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-400"></div>
              </label>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Server Status */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">System Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Database</CardTitle>
                  <CardDescription>CRM data storage</CardDescription>
                </div>
                {!editingDatabase && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingDatabase(true)}
                    className="h-8 w-8 p-0"
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!editingDatabase ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className={`h-3 w-3 rounded-full ${
                      databaseMode === 'cloud' ? 'bg-blue-400 animate-pulse' :
                      databaseMode === 'local' ? 'bg-green-400' :
                      'bg-yellow-400 animate-pulse'
                    }`} />
                    <p className={`text-sm ${
                      databaseMode === 'cloud' ? 'text-blue-400' :
                      databaseMode === 'local' ? 'text-green-400' :
                      'text-yellow-400'
                    }`}>
                      {databaseMode === 'cloud' ? '🌩️ Cloud (Supabase)' :
                       databaseMode === 'local' ? '💾 Local SQLite' :
                       'Detecting...'}
                    </p>
                  </div>
                  {databaseMode && (
                    <>
                      <p className="text-xs text-muted-foreground mt-2">
                        {databaseMode === 'cloud' ? 'Multi-device sync enabled' : 'Single-device mode'}
                      </p>
                      {databaseMode === 'cloud' && databaseUrl && databaseUrl !== 'Supabase PostgreSQL' && (
                        <p className="text-xs text-muted-foreground mt-1 font-mono">
                          {databaseUrl}
                        </p>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="supabase-url" className="text-xs">Supabase URL</Label>
                    <Input
                      id="supabase-url"
                      placeholder="https://your-project.supabase.co"
                      value={supabaseUrl}
                      onChange={(e) => setSupabaseUrl(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supabase-key" className="text-xs">Supabase Secret Key</Label>
                    <Input
                      id="supabase-key"
                      type="password"
                      placeholder="eyJhbGci..."
                      value={supabaseKey}
                      onChange={(e) => setSupabaseKey(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        setSavingDatabase(true)
                        try {
                          // Save to env.local via IPC
                          if (window.electronAPI?.config?.saveSupabaseConfig) {
                            await window.electronAPI.config.saveSupabaseConfig({
                              url: supabaseUrl,
                              key: supabaseKey
                            })
                          }
                          setEditingDatabase(false)
                          // Reload to apply changes
                          setTimeout(() => window.location.reload(), 500)
                        } catch (error) {
                          console.error('Failed to save database config:', error)
                        } finally {
                          setSavingDatabase(false)
                        }
                      }}
                      disabled={!supabaseUrl || !supabaseKey || savingDatabase}
                      className="h-8 text-xs"
                    >
                      {savingDatabase ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <Save className="h-3 w-3 mr-1" />
                      )}
                      Save & Reload
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingDatabase(false)}
                      className="h-8 text-xs"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Express Server</CardTitle>
              <CardDescription>Web dashboard and API</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${
                  expressStatus === 'running' ? 'bg-green-400 animate-pulse' :
                  expressStatus === 'checking' ? 'bg-yellow-400 animate-pulse' :
                  'bg-red-400'
                }`} />
                <p className={`text-sm ${
                  expressStatus === 'running' ? 'text-green-400' :
                  expressStatus === 'checking' ? 'text-yellow-400' :
                  'text-red-400'
                }`}>
                  {expressStatus === 'running' ? 'Running on :3000' :
                   expressStatus === 'checking' ? 'Checking...' :
                   'Not Running'}
                </p>
              </div>
              {expressStatus === 'stopped' && (
                <p className="text-xs text-muted-foreground mt-2">
                  Run <code className="bg-muted px-1 py-0.5 rounded">npm start</code> to start the server
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">MCP Server</CardTitle>
              <CardDescription>Claude AI integration</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${
                  mcpStatus === 'running' ? 'bg-green-400 animate-pulse' : 'bg-red-400'
                }`} />
                <p className={`text-sm ${
                  mcpStatus === 'running' ? 'text-green-400' : 'text-red-400'
                }`}>
                  {mcpStatus === 'running' ? 'Running (stdio)' : 'Not Running'}
                </p>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                4 tools available for Claude
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Quick Stats</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Total Connectors</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-green-400">{connectors.length}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {connectors.filter(c => c.status === 'active').length} active
                {connectors.filter(c => c.status === 'missing-index').length > 0 && `, ${connectors.filter(c => c.status === 'missing-index').length} missing index`}
                {connectors.filter(c => c.status === 'needs-fix').length > 0 && `, ${connectors.filter(c => c.status === 'needs-fix').length} needs fix`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Data Sources</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-green-400">{dataSources.length}</p>
              <p className="text-xs text-muted-foreground mt-1">Configured sources</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Visualizations</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-green-400">{visualizations.length}</p>
              <p className="text-xs text-muted-foreground mt-1">Charts and dashboards</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
