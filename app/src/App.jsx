import { useState, useEffect, lazy, Suspense } from 'react'
import { initBrowserAPI } from '@/lib/browserAPI'
import { parseUrl, buildUrl } from '@/lib/router'

// Initialize browser API shim if not in Electron
initBrowserAPI()
import {
  Settings,
  Menu,
  Bot,
  LineChart,
  Home as HomeIcon,
  FolderOpen,
  FolderKanban,
  DollarSign,
  Users,
  TrendingUp,
  BarChart3,
  Package,
  LogOut
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import Home from '@/components/Home'
import Overview from '@/components/Overview'
import VisualizationViewer from '@/components/VisualizationViewer'
import ProjectsViewer from '@/components/ProjectsViewer'
import PreviewLogin from '@/components/PreviewLogin'
import { useVimiumShortcuts } from '@/hooks/useVimiumShortcuts'

// Icon mapping for lucide-react icons
const getIconComponent = (iconName) => {
  const icons = {
    'DollarSign': DollarSign,
    'Users': Users,
    'TrendingUp': TrendingUp,
    'BarChart3': BarChart3
  }
  return icons[iconName] || Package
}

function LocalBaseApp({ previewLogin = false, previewMode = false, previewWorkspace = '', onAuthenticated, onSignOut }) {
  // Enable Vimium-style keyboard shortcuts
  useVimiumShortcuts()

  const [currentWorkspace, setCurrentWorkspace] = useState(previewWorkspace)

  // Parse initial URL to determine starting view
  const [selectedView, setSelectedView] = useState(() => {
    const initialUrl = window.__INITIAL_SEARCH__
      ? window.location.pathname + window.__INITIAL_SEARCH__
      : window.location.pathname + window.location.search
    const { view } = parseUrl(initialUrl)
    return view
  })

  // Track current viz/project IDs from URL
  const [currentVizId, setCurrentVizId] = useState(() => {
    const initialUrl = window.location.pathname + window.location.search
    const { vizId } = parseUrl(initialUrl)
    return vizId
  })
  const [currentProjectId, setCurrentProjectId] = useState(() => {
    const initialUrl = window.location.pathname + window.location.search
    const { projectId } = parseUrl(initialUrl)
    return projectId
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('localbase-sidebar-collapsed') === 'true'
  })
  const [vizKey, setVizKey] = useState(0)
  const [toolNavItems, setToolNavItems] = useState([])
  const [forceSingleWorkspace, setForceSingleWorkspace] = useState(() => {
    return localStorage.getItem('localbase-force-single-workspace') === 'true'
  })

  // Listen for single workspace mode changes
  useEffect(() => {
    const handler = (e) => setForceSingleWorkspace(e.detail)
    window.addEventListener('single-workspace-mode-changed', handler)
    return () => window.removeEventListener('single-workspace-mode-changed', handler)
  }, [])

  // Listen for tab switch requests from components
  useEffect(() => {
    const handler = (e) => {
      setSelectedView(e.detail)
      // Clear viz/project IDs when switching tabs via event
      setCurrentVizId(null)
      setCurrentProjectId(null)
    }
    window.addEventListener('app:switchTab', handler)
    return () => window.removeEventListener('app:switchTab', handler)
  }, [])

  // Listen for viz selection to update URL
  useEffect(() => {
    const handler = (e) => {
      setCurrentVizId(e.detail || null)
      if (e.detail) {
        setSelectedView('visualizations')
      }
    }
    window.addEventListener('viz:urlUpdate', handler)
    return () => window.removeEventListener('viz:urlUpdate', handler)
  }, [])

  // Listen for project selection to update URL (supports both projectId and vizId)
  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail || {}
      // Support both new format { projectId, vizId } and legacy string format
      const projectId = typeof detail === 'object' ? detail.projectId : detail
      const vizId = typeof detail === 'object' ? detail.vizId : null

      setCurrentProjectId(projectId || null)
      // Update viz ID in project context
      if (vizId !== undefined) {
        setCurrentVizId(vizId)
      }
      if (projectId) {
        setSelectedView('projects')
      }
    }
    window.addEventListener('project:urlUpdate', handler)
    return () => window.removeEventListener('project:urlUpdate', handler)
  }, [])

  // Listen for navigate:project events (from viz detail to project tab)
  useEffect(() => {
    const handler = (e) => {
      setSelectedView('projects')
      setCurrentProjectId(e.detail)
      setCurrentVizId(null)
      // Dispatch to ProjectsViewer to open specific project
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('projects:open', { detail: e.detail }))
      }, 50)
    }
    window.addEventListener('navigate:project', handler)
    return () => window.removeEventListener('navigate:project', handler)
  }, [])

  // Browser history management with URL routing
  useEffect(() => {
    // Set initial URL on mount (replace, don't push)
    const initialUrl = buildUrl(selectedView, currentVizId, currentProjectId)
    window.history.replaceState({ view: selectedView, vizId: currentVizId, projectId: currentProjectId }, '', initialUrl)

    const handlePopState = (e) => {
      // Parse URL on back/forward navigation
      const { view, vizId, projectId } = parseUrl(window.location.pathname + window.location.search)
      setSelectedView(view)
      setCurrentVizId(vizId)
      setCurrentProjectId(projectId)

      // Notify viz viewer if navigating to a specific viz
      if (vizId) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('viz:select', { detail: vizId }))
        }, 50)
      }
      // Notify projects viewer if navigating to a specific project
      if (projectId) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('projects:open', { detail: projectId }))
        }, 50)
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Update URL when view changes
  useEffect(() => {
    const newUrl = buildUrl(selectedView, currentVizId, currentProjectId)
    const currentUrl = window.location.pathname

    // Only push if URL actually changed
    if (newUrl !== currentUrl) {
      window.history.pushState({ view: selectedView, vizId: currentVizId, projectId: currentProjectId }, '', newUrl)
    }
  }, [selectedView, currentVizId, currentProjectId])

  // Load current workspace name
  const loadWorkspace = async () => {
    try {
      if (window.electronAPI?.config) {
        const projectRoot = await window.electronAPI.config.getProjectRoot()
        if (projectRoot) {
          const workspaceName = projectRoot.split('/').pop()
          setCurrentWorkspace(workspaceName)
        } else {
          setCurrentWorkspace('')
        }
      }
    } catch (err) {
      console.error('Failed to load workspace:', err)
    }
  }

  // Load tools with presentation: "sidebar" and build nav items
  const loadToolNavItems = async () => {
    try {
      if (window.electronAPI?.api) {
        const result = await window.electronAPI.api.getTools()
        if (result.success) {
          const sidebarTools = result.tools.filter(tool =>
            tool.config?.presentation === 'sidebar'
          )

          const navItems = []
          sidebarTools.forEach(tool => {
            if (tool.config.routes) {
              // Tool has multiple routes (like CRM)
              tool.config.routes.forEach(route => {
                navItems.push({
                  id: route.id,
                  label: route.label,
                  icon: getIconComponent(route.icon),
                  toolId: tool.id,
                  component: route.component
                })
              })
            } else {
              // Tool is a single component
              navItems.push({
                id: tool.id,
                label: tool.name,
                icon: getIconComponent(tool.config.icon || 'Package'),
                toolId: tool.id,
                component: null
              })
            }
          })

          console.log('📊 Loaded tool nav items:', navItems)
          setToolNavItems(navItems)
        }
      }
    } catch (err) {
      console.error('Failed to load tool nav items:', err)
    }
  }

  useEffect(() => {
    if (previewLogin) return undefined
    loadWorkspace()
    loadToolNavItems()
  }, [previewLogin])

  // Reload tools when workspace changes
  useEffect(() => {
    if (previewLogin) return
    if (currentWorkspace) {
      console.log('🔄 Workspace changed, reloading tools:', currentWorkspace)
      loadToolNavItems()
    }
  }, [currentWorkspace, previewLogin])

  // Persist sidebar state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('localbase-sidebar-collapsed', sidebarCollapsed)
  }, [sidebarCollapsed])

  // Persist selected view to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('localbase-selected-view', selectedView)
  }, [selectedView])

  // Global keyboard handlers
  useEffect(() => {
    const handleKeyPress = (e) => {
      // Command+B: Toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        console.log('📊 App: Command+B - toggling sidebar')
        setSidebarCollapsed(prev => !prev)
        return
      }

      // Command+R: Refresh current view instead of reloading app
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()

        if (selectedView === 'visualizations') {
          console.log('🔄 App: Command+R on Visualizations - dispatching refresh event')
          window.dispatchEvent(new CustomEvent('visualizations:refresh'))
        } else {
          console.log('🔄 App: Command+R on', selectedView, '- refreshing viz key')
          setVizKey(prev => prev + 1)
        }
        return
      }

      // Escape: Go home (unless vim hints are active or in input field)
      if (e.key === 'Escape') {
        // Don't interfere with vim hints (they handle Escape themselves)
        if (window.vimHintsActive) {
          return
        }

        // Don't interfere when typing in input fields
        if (e.target.tagName === 'INPUT' ||
            e.target.tagName === 'TEXTAREA' ||
            e.target.isContentEditable) {
          return
        }

        // Don't navigate away from CRM views - let them handle Escape
        if (selectedView === 'pipeline' || selectedView === 'customers') {
          return
        }

        // Go home if not already there
        if (selectedView !== 'home') {
          console.log('🏠 App: Escape pressed - going home')
          setSelectedView('home')
          e.preventDefault()
        }
      }
    }

    // Listen for goHome event (from Terminal component)
    const handleGoHome = () => {
      if (selectedView !== 'home') {
        console.log('🏠 App: Received goHome event - going home')
        setSelectedView('home')
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    window.addEventListener('app:goHome', handleGoHome)
    return () => {
      window.removeEventListener('keydown', handleKeyPress)
      window.removeEventListener('app:goHome', handleGoHome)
    }
  }, [selectedView])

  const handleSwitchWorkspace = () => {
    setSelectedView('home')
  }

  const handleSignOut = async () => {
    if (!window.electronAPI?.auth?.logout) return
    const success = await window.electronAPI.auth.logout()
    if (success) onSignOut?.()
  }

  // Build combined navigation: core items + tool items + settings
  const coreNavItems = [
    { id: 'projects', label: 'Projects', icon: FolderKanban },
    { id: 'visualizations', label: 'Visualizations', icon: LineChart },
  ]

  const settingsNavItems = [
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  const navItems = [...coreNavItems, ...toolNavItems, ...settingsNavItems]

  return (
    <div className="flex h-screen bg-background text-foreground dark flex-col">
      {/* Top Bar */}
      <div className="h-14 bg-white/10 backdrop-blur-xl border-b border-white/15 flex items-center justify-between px-4">
        <div
          className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={() => setSelectedView('home')}
        >
          <Bot className="h-4 w-4 text-green-400" />
          <span className="text-xs font-mono text-muted-foreground">LocalBase</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
          <FolderOpen className="h-3.5 w-3.5" />
          <span>{currentWorkspace || 'workspace'}</span>
          {previewMode && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="h-7 w-7 text-green-400 hover:bg-green-400/10 hover:text-green-300"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          className={`${
            sidebarCollapsed ? 'w-16' : 'w-64'
          } bg-white/7.5 backdrop-blur-xl border-r border-white/15 transition-all duration-300 flex flex-col`}
        >
        {/* Navigation */}
        <nav className="flex-1 p-2 pt-4">
          {navItems.map((item) => {
            const Icon = item.icon
            const handleClick = () => {
              if (item.id === 'visualizations') {
                // Dispatch event to reset viz viewer to gallery (don't remount, just reset state)
                window.dispatchEvent(new CustomEvent('viz:showGallery'))
                setCurrentVizId(null)
              }
              if (item.id === 'projects') {
                setCurrentProjectId(null)
              }
              setSelectedView(item.id)
            }

            return (
              <div key={item.id}>
                <Button
                  variant={selectedView === item.id ? 'secondary' : 'ghost'}
                  className={`w-full mb-1 h-9 text-xs ${
                    sidebarCollapsed ? 'justify-center px-2' : 'justify-start'
                  }`}
                  onClick={handleClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleClick()
                    }
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {!sidebarCollapsed && (
                    <span className="ml-2">{item.label}</span>
                  )}
                </Button>
              </div>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-white/15 flex items-center justify-between">
          {!sidebarCollapsed ? (
            <>
              <p className="text-[11px] text-muted-foreground font-mono">
                <span className="text-primary">&gt;&gt;</span> LocalBase v1.0
              </p>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="h-6 w-6"
              >
                <Menu className="h-3 w-3" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="h-6 w-6 mx-auto"
            >
              <Menu className="h-3 w-3" />
            </Button>
          )}
        </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-auto">
        <div className="h-full">
          {previewLogin ? (
            <Home previewLogin previewWorkspace={previewWorkspace} onAuthenticated={onAuthenticated} />
          ) : selectedView === 'home' ? (
            <Home
              onWorkspaceSelected={() => {
                loadWorkspace()
                setSelectedView('visualizations')
              }}
            />
          ) : selectedView === 'visualizations' ? (
            <VisualizationViewer key={vizKey} />
          ) : selectedView === 'projects' ? (
            <ProjectsViewer
              initialProjectId={currentProjectId}
              initialVizId={currentVizId}
            />
          ) : selectedView === 'settings' ? (
            <Overview onNavigateHome={() => setSelectedView('home')} />
          ) : null}
        </div>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [authState, setAuthState] = useState({ status: 'checking', preview: false, authenticated: false, workspace: '' })

  useEffect(() => {
    let active = true
    const auth = window.electronAPI?.auth
    if (!auth) {
      setAuthState({ status: 'ready', preview: false, authenticated: true, workspace: '' })
      return () => { active = false }
    }
    auth.getSession().then((session) => {
      if (!active) return
      setAuthState({ status: 'ready', ...session })
    }).catch(() => {
      if (active) setAuthState({ status: 'ready', preview: false, authenticated: true, workspace: '' })
    })
    return () => { active = false }
  }, [])

  if (authState.status === 'checking') {
    return <div className="min-h-screen bg-background dark" aria-busy="true" />
  }
  if (authState.preview && !authState.authenticated) {
    return <LocalBaseApp
      previewLogin
      previewWorkspace={authState.workspace}
      onAuthenticated={(session) => setAuthState((current) => ({ ...current, ...session, authenticated: true }))}
    />
  }
  return <LocalBaseApp
    previewMode={authState.preview}
    onSignOut={() => setAuthState((current) => ({ ...current, authenticated: false }))}
  />
}

export default App
