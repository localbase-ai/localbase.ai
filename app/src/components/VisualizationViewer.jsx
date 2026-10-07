import { useState, useEffect, useRef } from 'react'
import { vizUrl, isVizMessage, VIZ_SANDBOX } from '@/lib/vizOrigin'
import { X, BarChart3, Trash2, LayoutGrid, List, Search, Star, Presentation } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { parseUrl } from '@/lib/router'

// Helper to build viz URLs - uses HTTP in browser mode, localbase:// in Electron
const buildVizUrl = (vizPath) => `${vizUrl(vizPath)}?t=${Date.now()}`

export default function VisualizationViewer() {
  const [visualizations, setVisualizations] = useState([])
  const [selectedViz, setSelectedViz] = useState(null)
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('viz-view-mode') || 'grid')
  const [typeFilter, setTypeFilter] = useState(() => localStorage.getItem('viz-type-filter') || 'all')
  const [searchQuery, setSearchQuery] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [iframeUrl, setIframeUrl] = useState('')
  const [initialRestoreAttempted, setInitialRestoreAttempted] = useState(false)
  const searchInputRef = useRef(null)

  // Get viz ID from URL on initial load. Delegates to the shared router so
  // /viz/:id, /viz/:id.html, and legacy ?viz=id all resolve consistently.
  const getVizIdFromUrl = () => {
    const search = window.__INITIAL_SEARCH__ || window.location.search
    return parseUrl(window.location.pathname + search).vizId
  }

  // Fetch visualizations
  useEffect(() => {
    const fetchVisualizations = async () => {
      try {
        const data = await window.electronAPI.api.getVisualizations()
        setVisualizations(data.visualizations || [])
      } catch (err) {
        console.error('Failed to fetch visualizations:', err)
      }
    }
    fetchVisualizations()
    const interval = setInterval(fetchVisualizations, 30000)
    return () => clearInterval(interval)
  }, [])

  // Persist preferences
  useEffect(() => { localStorage.setItem('viz-view-mode', viewMode) }, [viewMode])
  useEffect(() => { localStorage.setItem('viz-type-filter', typeFilter) }, [typeFilter])

  // Event: refresh iframe
  useEffect(() => {
    const handler = () => setIframeKey(prev => prev + 1)
    window.addEventListener('visualizations:refresh', handler)
    return () => window.removeEventListener('visualizations:refresh', handler)
  }, [])

  // Event: show gallery (reset to index)
  useEffect(() => {
    const handler = () => setSelectedViz(null)
    window.addEventListener('viz:showGallery', handler)
    return () => window.removeEventListener('viz:showGallery', handler)
  }, [])

  // Event: select viz (from chat or project iframe via postMessage)
  useEffect(() => {
    const handleEvent = (e) => {
      const vizId = e.detail
      const viz = visualizations.find(v => v.id === vizId)
      if (viz) setSelectedViz(viz)
    }
    const handleMessage = (e) => {
      // Vizzes are served from this origin; any other sender is a page that framed us.
      if (!isVizMessage(e)) return
      if (e.data?.type === 'viz:select' && e.data?.vizId) {
        const viz = visualizations.find(v => v.id === e.data.vizId)
        if (viz) setSelectedViz(viz)
      }
    }
    window.addEventListener('viz:select', handleEvent)
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('viz:select', handleEvent)
      window.removeEventListener('message', handleMessage)
    }
  }, [visualizations])

  // Keyboard: Cmd+K to focus search, Escape to clear
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if (e.key === 'Escape') {
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // URL: restore viz from ?viz= param on load
  useEffect(() => {
    if (visualizations.length > 0 && !selectedViz && !initialRestoreAttempted) {
      const vizId = getVizIdFromUrl()
      if (vizId) {
        const viz = visualizations.find(v => v.id === vizId)
        if (viz) setSelectedViz(viz)
      }
      setInitialRestoreAttempted(true)
    }
  }, [visualizations, initialRestoreAttempted])

  // No history write here on purpose. App.jsx owns the URL: selecting a viz
  // dispatches viz:urlUpdate with its id, "Back to Gallery" dispatches null, and
  // App's effect pushes the matching path. This component used to ALSO push a
  // ?viz= query form for the same click, which cost two history entries per
  // navigation — so one Back press only undid half of it and landed on
  // /visualizations?viz=<id>, a URL whose path and query disagree. parseUrl
  // reads query params before the path, so the query won and the viz stayed on
  // screen: Back appeared to do nothing. ?viz= is still READ (see parseUrl and
  // the popstate handler below) so existing bookmarks keep resolving.

  // URL: handle browser back/forward
  useEffect(() => {
    const handler = () => {
      const vizId = getVizIdFromUrl()
      if (vizId) {
        const viz = visualizations.find(v => v.id === vizId)
        if (viz) setSelectedViz(viz)
      } else {
        setSelectedViz(null)
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [visualizations])

  // LiveWorkspace integration: open viz from localStorage
  useEffect(() => {
    const vizToOpen = localStorage.getItem('vizViewer_openOnMount')
    if (vizToOpen && visualizations.length > 0) {
      localStorage.removeItem('vizViewer_openOnMount')
      try {
        const vizData = JSON.parse(vizToOpen)
        const matchingViz = visualizations.find(v => v.id === vizData.id || v.filename === vizData.filename)
        if (matchingViz) {
          setSelectedViz(matchingViz)
        } else {
          setSelectedViz({
            ...vizData,
            url: vizData.filename ? `app/viz/${vizData.filename}` : vizData.url.replace(/^localbase:\/\//, '').replace(/\?t=\d+$/, '')
          })
        }
      } catch (err) {
        console.error('Failed to parse viz from localStorage:', err)
      }
    }
  }, [visualizations])

  // Update iframe URL when viz changes
  useEffect(() => {
    if (selectedViz) {
      setIframeUrl(buildVizUrl(selectedViz.url))
    }
  }, [selectedViz?.id, iframeKey])

  // Handlers
  const handleDeleteClick = (e, viz) => {
    e.stopPropagation()
    setDeleteConfirm(viz)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const viz = deleteConfirm
    setDeleteConfirm(null)
    setDeletingId(viz.id)
    try {
      const result = await window.electronAPI.api.deleteVisualization(viz.id)
      if (result.success) {
        setVisualizations(prev => prev.filter(v => v.id !== viz.id))
      } else {
        alert(`Failed to delete: ${result.error}`)
      }
    } catch (err) {
      alert(`Error deleting visualization: ${err.message}`)
    } finally {
      setDeletingId(null)
    }
  }

  const handlePin = async (e, viz) => {
    e.stopPropagation()
    try {
      const newPinnedState = !viz.pinned
      const result = await window.electronAPI.api.toggleVizPin(viz.id, newPinnedState)
      if (result.success) {
        setVisualizations(prev => prev.map(v => v.id === viz.id ? { ...v, pinned: newPinnedState } : v))
      } else {
        alert(`Failed to ${newPinnedState ? 'pin' : 'unpin'}: ${result.error}`)
      }
    } catch (err) {
      alert(`Error ${viz.pinned ? 'unpinning' : 'pinning'} visualization: ${err.message}`)
    }
  }

  const handleVizClick = (viz) => {
    const vizData = { id: viz.id, title: viz.title, filename: viz.filename, url: buildVizUrl(`viz/${viz.filename}`) }
    localStorage.setItem('liveWorkspace_lastSession', JSON.stringify(vizData))
    window.dispatchEvent(new CustomEvent('liveWorkspace:loadViz', { detail: viz }))
    // Update URL with viz ID
    window.dispatchEvent(new CustomEvent('viz:urlUpdate', { detail: viz.id }))
    setSelectedViz(viz)
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Unknown'
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // Computed values
  const vizTypes = [...new Set(visualizations.map(v => v.type))].sort()

  let filteredVisualizations = visualizations
  if (typeFilter !== 'all') {
    filteredVisualizations = filteredVisualizations.filter(v => v.type === typeFilter)
  }
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase()
    filteredVisualizations = filteredVisualizations.filter(v =>
      v.title?.toLowerCase().includes(query) ||
      v.filename?.toLowerCase().includes(query) ||
      v.id?.toLowerCase().includes(query)
    )
  }
  filteredVisualizations = [...filteredVisualizations].sort((a, b) => {
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  })
  const pinnedViz = filteredVisualizations.filter(v => v.pinned)
  const unpinnedViz = filteredVisualizations.filter(v => !v.pinned)

  // Render: Single viz view
  if (selectedViz) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            {selectedViz.project && (
              <button onClick={() => window.dispatchEvent(new CustomEvent('navigate:project', { detail: selectedViz.project }))} className="text-xs text-green-400 hover:text-green-300 mb-1 flex items-center gap-1">
                <Presentation className="h-3 w-3" /> {selectedViz.project}
              </button>
            )}
            <h3 className="text-lg font-semibold text-green-400">{selectedViz.title}</h3>
            <p className="text-xs text-muted-foreground">
              {selectedViz.library} • {selectedViz.type} • {formatDate(selectedViz.createdAt)}
            </p>
            <p className="text-xs text-muted-foreground/60 font-mono mt-1 select-all cursor-text">
              ID: {selectedViz.id} • app/viz/{selectedViz.filename}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { setSelectedViz(null); window.dispatchEvent(new CustomEvent('viz:urlUpdate', { detail: null })) }} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4 mr-2" /> Back to Gallery
          </Button>
        </div>
        <div className="flex-1 bg-background overflow-auto">
          <iframe key={iframeKey} src={iframeUrl} className="w-full h-full border-0" title={selectedViz.title} sandbox={VIZ_SANDBOX} allow="fullscreen; clipboard-write" allowFullScreen />
        </div>
      </div>
    )
  }

  // Render: Gallery
  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-green-400">Visualizations</h2>
          <p className="text-muted-foreground text-sm">Browse and view your LocalBase visualizations</p>
        </div>
        <div className="flex gap-2">
          <Button variant={viewMode === 'grid' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('grid')} className="gap-2">
            <LayoutGrid className="h-4 w-4" /> Grid
          </Button>
          <Button variant={viewMode === 'list' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('list')} className="gap-2">
            <List className="h-4 w-4" /> List
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search visualizations... (⌘K)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:border-green-400 focus:outline-none transition-colors"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Type Filter */}
      <div className="mb-6 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter:</span>
        <Button variant={typeFilter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTypeFilter('all')} className="h-8 px-3 text-xs">
          All ({visualizations.length})
        </Button>
        {vizTypes.map(type => (
          <Button key={type} variant={typeFilter === type ? 'secondary' : 'ghost'} size="sm" onClick={() => setTypeFilter(type)} className="h-8 px-3 text-xs capitalize">
            {type} ({visualizations.filter(v => v.type === type).length})
          </Button>
        ))}
      </div>

      {/* Grid View */}
      {viewMode === 'grid' && (
        <>
          {pinnedViz.length > 0 && (
            <div className="mb-8">
              <h3 className="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2">
                <Star className="h-4 w-4 fill-yellow-400" /> Pinned ({pinnedViz.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {pinnedViz.map(viz => <VizCard key={viz.id} viz={viz} onClick={handleVizClick} onPin={handlePin} onDelete={handleDeleteClick} deletingId={deletingId} formatDate={formatDate} />)}
              </div>
            </div>
          )}
          {unpinnedViz.length > 0 && (
            <div>
              {pinnedViz.length > 0 && <h3 className="text-sm font-semibold text-muted-foreground mb-3">All Visualizations ({unpinnedViz.length})</h3>}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {unpinnedViz.map(viz => <VizCard key={viz.id} viz={viz} onClick={handleVizClick} onPin={handlePin} onDelete={handleDeleteClick} deletingId={deletingId} formatDate={formatDate} />)}
              </div>
            </div>
          )}
        </>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <>
          {pinnedViz.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2">
                <Star className="h-4 w-4 fill-yellow-400" /> Pinned ({pinnedViz.length})
              </h3>
              <div className="space-y-2">
                {pinnedViz.map(viz => <VizListItem key={viz.id} viz={viz} onClick={handleVizClick} onPin={handlePin} onDelete={handleDeleteClick} deletingId={deletingId} formatDate={formatDate} />)}
              </div>
            </div>
          )}
          {unpinnedViz.length > 0 && (
            <div>
              {pinnedViz.length > 0 && <h3 className="text-sm font-semibold text-muted-foreground mb-3">All Visualizations ({unpinnedViz.length})</h3>}
              <div className="space-y-2">
                {unpinnedViz.map(viz => <VizListItem key={viz.id} viz={viz} onClick={handleVizClick} onPin={handlePin} onDelete={handleDeleteClick} deletingId={deletingId} formatDate={formatDate} />)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty States */}
      {visualizations.length === 0 && (
        <div className="text-center text-muted-foreground py-12">
          <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No visualizations found</p>
          <p className="text-xs mt-2">Create visualizations in LocalBase to see them here</p>
        </div>
      )}
      {visualizations.length > 0 && filteredVisualizations.length === 0 && (
        <div className="text-center text-muted-foreground py-12">
          <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No {typeFilter} visualizations found</p>
          <p className="text-xs mt-2">Try selecting a different filter</p>
        </div>
      )}

      {/* Delete Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-card border border-border rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-lg font-semibold mb-2">Delete "{deleteConfirm.title}"?</h3>
            <p className="text-sm text-muted-foreground mb-6">This will permanently delete the visualization file and cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteConfirm} className="bg-red-600 hover:bg-red-700">Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Sub-components
function VizCard({ viz, onClick, onPin, onDelete, deletingId, formatDate }) {
  return (
    <Card className="group cursor-pointer transition-all hover:border-green-400/50 overflow-hidden" onClick={() => onClick(viz)}>
      <div className="flex gap-3 p-3">
        <div className="w-20 h-20 flex-shrink-0 bg-background/50 relative overflow-hidden rounded border border-border/50 flex items-center justify-center">
          <BarChart3 className="h-10 w-10 text-green-400/30" />
        </div>
        <div className="flex-1 min-w-0 py-1">
          <div className="flex items-start gap-2 mb-1">
            <BarChart3 className="h-4 w-4 text-green-400 flex-shrink-0 mt-0.5" />
            <h3 className="text-sm font-semibold leading-tight">{viz.title}</h3>
          </div>
          <p className="text-xs text-muted-foreground">{viz.description || `Created ${formatDate(viz.createdAt)}`}</p>
          <div className="flex gap-2 mt-2 text-xs text-muted-foreground">
            <span className="capitalize">{viz.type}</span>
            <span>•</span>
            <span>{viz.library}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" className={`h-8 w-8 transition-opacity ${viz.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => onPin(e, viz)}>
          <Star className={`h-4 w-4 ${viz.pinned ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground hover:text-yellow-400'}`} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive" onClick={(e) => onDelete(e, viz)} disabled={deletingId === viz.id}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

function VizListItem({ viz, onClick, onPin, onDelete, deletingId, formatDate }) {
  return (
    <Card className="group cursor-pointer transition-all hover:border-green-400/50" onClick={() => onClick(viz)}>
      <div className="flex items-center gap-4 p-4">
        <BarChart3 className="h-5 w-5 text-green-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">{viz.title}</h3>
          <p className="text-xs text-muted-foreground">{viz.description || `Created ${formatDate(viz.createdAt)}`}</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="capitalize">{viz.type}</span>
          <span>{viz.library}</span>
          <span>{formatDate(viz.createdAt)}</span>
        </div>
        <Button variant="ghost" size="icon" className={`h-8 w-8 transition-opacity flex-shrink-0 ${viz.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => onPin(e, viz)}>
          <Star className={`h-4 w-4 ${viz.pinned ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground hover:text-yellow-400'}`} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive flex-shrink-0" onClick={(e) => onDelete(e, viz)} disabled={deletingId === viz.id}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}
