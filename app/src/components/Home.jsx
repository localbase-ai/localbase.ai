import { Bot, Database, Check, CornerDownLeft, Trash2 } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import PreviewLogin from '@/components/PreviewLogin'

export default function Home({ onWorkspaceSelected, previewLogin = false, previewWorkspace = '', onAuthenticated }) {
  const canvasRef = useRef(null)
  const [availableProjects, setAvailableProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [currentWorkspace, setCurrentWorkspace] = useState(previewWorkspace)
  const [forceSingleWorkspace, setForceSingleWorkspace] = useState(() => {
    return localStorage.getItem('localbase-force-single-workspace') === 'true'
  })
  const [deleteConfirm, setDeleteConfirm] = useState(null) // workspace path to confirm delete

  // Listen for single workspace mode changes
  useEffect(() => {
    const handler = (e) => setForceSingleWorkspace(e.detail)
    window.addEventListener('single-workspace-mode-changed', handler)
    return () => window.removeEventListener('single-workspace-mode-changed', handler)
  }, [])

  // Load current workspace name and scan for projects
  useEffect(() => {
    if (previewLogin) return undefined
    const loadWorkspace = async () => {
      if (window.electronAPI?.config) {
        const projectRoot = await window.electronAPI.config.getProjectRoot()
        if (projectRoot) {
          const workspaceName = projectRoot.split('/').pop()
          setCurrentWorkspace(workspaceName)
        } else {
          setCurrentWorkspace('')
        }
      }
    }
    loadWorkspace()
    scanForProjects()
  }, [previewLogin])

  // Scan for available projects
  const scanForProjects = async () => {
    if (previewLogin) return
    setScanning(true)
    const projects = []

    try {
      // Browser mode: use workspaces API
      if (window.electronAPI?.workspaces) {
        const result = await window.electronAPI.workspaces.list()
        if (result.success && result.workspaces) {
          setAvailableProjects(result.workspaces.map(ws => ({
            name: ws.name,
            path: ws.path,
            active: ws.active
          })))
          setScanning(false)
          return
        }
      }

      // Electron mode: scan filesystem
      if (!window.electronAPI?.files) {
        setScanning(false)
        return
      }

      const home = await window.electronAPI.files.getHome()
      if (!home) {
        // Browser mode fallback - no home directory available
        setScanning(false)
        return
      }

      const locationsToScan = [`${home}/Work`, home]

      for (const location of locationsToScan) {
        try {
          const entries = await window.electronAPI.files.listDirectory(location)
          for (const entry of entries) {
            if (entry.isDirectory) {
              const fullPath = `${location}/${entry.name}`
              const isLocalBase = await checkIfLocalBaseProject(fullPath)
              if (isLocalBase) {
                projects.push({
                  name: entry.name,
                  path: fullPath,
                  modified: entry.modified
                })
              }
            }
          }
        } catch (err) {
          console.error(`Failed to scan ${location}:`, err)
        }
      }

      const filteredProjects = projects.filter(p => p.name !== 'localbase.ai')
      setAvailableProjects(filteredProjects)
    } catch (err) {
      console.error('Scan error:', err)
    } finally {
      setScanning(false)
    }
  }

  const checkIfLocalBaseProject = async (dirPath) => {
    try {
      const entries = await window.electronAPI.files.listDirectory(dirPath)
      const entryNames = entries.map(e => e.name)
      const hasConnectors = entryNames.includes('connectors')
      const hasTools = entryNames.includes('tools')
      const hasPackageJson = entryNames.includes('package.json')
      return hasConnectors && hasTools && hasPackageJson
    } catch {
      return false
    }
  }

  const handleProjectSelect = async () => {
    if (!selectedProject || !window.electronAPI?.config) return

    try {
      await window.electronAPI.config.setProjectRoot(selectedProject.path)
      localStorage.setItem('localbase-workspace-selected', 'true')
      localStorage.setItem('localbase-selected-view', 'live')
      onWorkspaceSelected()
    } catch (err) {
      console.error('Failed to save project root:', err)
    }
  }

  const handleDeleteWorkspace = async (workspacePath) => {
    if (!window.electronAPI?.workspace) return

    try {
      const result = await window.electronAPI.workspace.delete(workspacePath)

      if (result.success) {
        setDeleteConfirm(null)
        // Refresh workspace list
        scanForProjects()
      } else {
        alert(`Failed to delete workspace: ${result.error}`)
      }
    } catch (err) {
      console.error('Failed to delete workspace:', err)
      alert(`Failed to delete workspace: ${err.message}`)
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight

    const centerX = canvas.width / 2
    const centerY = canvas.height / 2

    // Create stars flying from center - WIDE VIEW
    const stars = Array.from({ length: 800 }, () => {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * 2000
      return {
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance,
        z: Math.random() * 3000,
        angle: angle,
        speed: Math.random() * 6 + 2
      }
    })

    let animationId
    const animate = () => {
      // Fade effect instead of clear for motion blur
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      stars.forEach(star => {
        // Move star towards camera
        star.z -= star.speed

        // Reset star when it goes past camera
        if (star.z <= 0) {
          star.z = 3000
          star.angle = Math.random() * Math.PI * 2
          const distance = Math.random() * 2000
          star.x = centerX + Math.cos(star.angle) * distance
          star.y = centerY + Math.sin(star.angle) * distance
        }

        // 3D projection
        const k = 128 / star.z
        const px = (star.x - centerX) * k + centerX
        const py = (star.y - centerY) * k + centerY

        // Star size based on depth (closer = bigger)
        const size = (1 - star.z / 3000) * 0.8

        // Brightness based on depth
        const opacity = (1 - star.z / 3000) * 0.7

        // Draw star with motion trail
        const prevZ = star.z + star.speed
        const prevK = 128 / prevZ
        const prevPx = (star.x - centerX) * prevK + centerX
        const prevPy = (star.y - centerY) * prevK + centerY

        // Draw line from previous position for streak effect
        ctx.beginPath()
        ctx.moveTo(prevPx, prevPy)
        ctx.lineTo(px, py)
        ctx.strokeStyle = `rgba(134, 239, 172, ${opacity * 0.6})`
        ctx.lineWidth = size * 0.5
        ctx.stroke()

        // Draw star point
        ctx.beginPath()
        ctx.arc(px, py, size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(134, 239, 172, ${opacity})`
        ctx.fill()
      })

      animationId = requestAnimationFrame(animate)
    }

    animate()

    // Handle window resize
    const handleResize = () => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    }
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <div className="h-full relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ background: 'transparent' }}
      />
      {/* Scrollable layer: min-h-full + items-center centers short content but
          still scrolls once the workspace grid outgrows the viewport. */}
      <div className="relative z-10 h-full overflow-y-auto">
        <div className="min-h-full flex items-center justify-center py-12 px-8">
          <div className="text-center space-y-8 w-full max-w-6xl" style={{ zoom: 0.8 }}>
        <div className="space-y-6">
          <Bot className="h-24 w-24 mx-auto text-green-400 opacity-80" strokeWidth={1} />

          <div className="space-y-2">
            <h1 className="text-2xl font-medium tracking-tight text-muted-foreground">
              welcome to
            </h1>
            <h2 className="text-5xl font-bold tracking-tight text-green-400 font-mono">
              localbase
            </h2>
          </div>

          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mx-auto">
            your local-first analytics workspace
          </p>
        </div>

        {/* Workspace Section */}
        <div className="mt-8 space-y-6">
          {previewLogin ? (
            <PreviewLogin workspace={previewWorkspace} onAuthenticated={onAuthenticated} />
          ) : (
          <>
          {/* Single Workspace Mode */}
          {forceSingleWorkspace ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">current workspace</p>
              <Card className="max-w-md mx-auto border-border bg-muted/30">
                <CardHeader className="pb-2 px-3 pt-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-foreground">{currentWorkspace || 'loading...'}</span>
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>
          ) : (
            /* Available Workspaces */
            scanning ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-green-400 mb-2"></div>
                <p className="text-xs text-muted-foreground">scanning...</p>
              </div>
            ) : availableProjects.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">select workspace</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {availableProjects.map((project) => (
                    <Card
                      key={project.path}
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer transition-all hover:scale-[1.02] border-border hover:border-green-400/50 group relative"
                      onClick={async (e) => {
                        // Don't open workspace if clicking delete button
                        if (e.target.closest('[data-delete-btn]')) return
                        if (deleteConfirm === project.path) return
                        // Auto-open workspace on click
                        if (!window.electronAPI?.config) return
                        try {
                          await window.electronAPI.config.setProjectRoot(project.path)
                          localStorage.setItem('localbase-workspace-selected', 'true')
                          // In browser mode (no terminal), go to visualizations instead of live
                          const isBrowserMode = !window.electronAPI?.terminal
                          localStorage.setItem('localbase-selected-view', isBrowserMode ? 'visualizations' : 'live')
                          onWorkspaceSelected()
                        } catch (err) {
                          console.error('Failed to save project root:', err)
                        }
                      }}
                    >
                      <CardHeader className="p-3">
                        <CardTitle className="flex items-start gap-2 text-sm text-left">
                          <Database className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0 text-left flex-1">
                            <span className="font-mono block">{project.name}</span>
                            <span
                              className="text-xs text-muted-foreground font-mono truncate block"
                              title={project.path}
                            >
                              {project.path}
                            </span>
                          </div>
                          {/* Delete button - only show if not the framework */}
                          {!project.path.endsWith('/localbase.ai') && (
                            <button
                              data-delete-btn
                              onClick={(e) => {
                                e.stopPropagation()
                                setDeleteConfirm(project.path)
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-500/20 rounded text-muted-foreground hover:text-red-400"
                              title="Delete workspace"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </CardTitle>
                      </CardHeader>
                      {/* Delete confirmation */}
                      {deleteConfirm === project.path && (
                        <div className="absolute inset-0 bg-card/95 backdrop-blur-sm flex items-center justify-center rounded-lg border border-red-500/50">
                          <div className="text-center space-y-2 p-3">
                            <p className="text-xs text-red-400 font-medium">Delete this workspace?</p>
                            <p className="text-xs text-muted-foreground">This cannot be undone</p>
                            <div className="flex gap-2 justify-center">
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteWorkspace(project.path)
                                }}
                                className="h-7 text-xs px-3"
                              >
                                Delete
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeleteConfirm(null)
                                }}
                                className="h-7 text-xs px-3"
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-xs text-muted-foreground">No workspaces found</p>
              </div>
            )
          )}
          </>
          )}
        </div>

          </div>
        </div>
      </div>
    </div>
  )
}
