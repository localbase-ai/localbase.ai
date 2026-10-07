import { useState, useEffect } from 'react'
import { vizUrl, isVizMessage, VIZ_SANDBOX } from '@/lib/vizOrigin'
import { FolderKanban, Presentation, Bot, Play, X, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

// Helper to build viz URLs (no timestamp to prevent iframe reload on re-render)
const buildVizUrl = (vizPath) => vizUrl(vizPath)

export default function ProjectsViewer({ initialProjectId, initialVizId }) {
  const [presentationProjects, setPresentationProjects] = useState([])
  const [agentProjects, setAgentProjects] = useState([])
  const [projectCounts, setProjectCounts] = useState({})
  const [selectedProject, setSelectedProject] = useState(initialProjectId || null)
  const [selectedProjectType, setSelectedProjectType] = useState(null) // 'presentation' or 'agent'
  const [currentVizId, setCurrentVizId] = useState(initialVizId || null)
  const [loading, setLoading] = useState(true)

  // Fetch projects from API
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await window.electronAPI.api.getVisualizations()
        const vizzes = data.visualizations || []
        const projectsWithPres = data.projectsWithPresentation || []
        const agents = data.agentProjects || []

        // Build project list with counts. Presentation projects are counted by
        // their rendered pages (from the API); registry-tagged viz add on top.
        const counts = { ...(data.presentationCounts || {}) }
        vizzes.forEach(v => {
          if (v.project) {
            counts[v.project] = (counts[v.project] || 0) + 1
          }
        })

        setProjectCounts(counts)
        setPresentationProjects(projectsWithPres)
        setAgentProjects(agents)
        setLoading(false)
      } catch (err) {
        console.error('Failed to fetch projects:', err)
        setLoading(false)
      }
    }
    fetchProjects()
  }, [])

  // Restore the project TYPE on deep-link refresh. selectedProject can come straight
  // from the URL (initialProjectId), but its type isn't known until projects load —
  // without this, refreshing /project/:id falls through to the project index.
  useEffect(() => {
    if (!selectedProject || selectedProjectType) return
    if (presentationProjects.includes(selectedProject)) setSelectedProjectType('presentation')
    else if (agentProjects.find(a => a.id === selectedProject)) setSelectedProjectType('agent')
  }, [presentationProjects, agentProjects, selectedProject, selectedProjectType])

  // Listen for viz:select from project iframe - update URL instead of switching tabs
  useEffect(() => {
    const handleMessage = (e) => {
      // Vizzes are served from this origin; any other sender is a page that framed us.
      if (!isVizMessage(e)) return
      if (e.data?.type === 'viz:select' && e.data?.vizId && selectedProject) {
        setCurrentVizId(e.data.vizId)
        // Update URL with both project and viz IDs
        window.dispatchEvent(new CustomEvent('project:urlUpdate', {
          detail: { projectId: selectedProject, vizId: e.data.vizId }
        }))
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [selectedProject])

  // Listen for projects:open events (from viz detail project link)
  useEffect(() => {
    const handler = (e) => {
      if (e.detail && presentationProjects.includes(e.detail)) {
        setSelectedProject(e.detail)
        setSelectedProjectType('presentation')
        setCurrentVizId(null)
        window.dispatchEvent(new CustomEvent('project:urlUpdate', {
          detail: { projectId: e.detail, vizId: null }
        }))
      }
    }
    window.addEventListener('projects:open', handler)
    return () => window.removeEventListener('projects:open', handler)
  }, [presentationProjects])

  // Helper to select project and update URL
  const handlePresentationProjectClick = (project) => {
    setSelectedProject(project)
    setSelectedProjectType('presentation')
    setCurrentVizId(null)
    window.dispatchEvent(new CustomEvent('project:urlUpdate', {
      detail: { projectId: project, vizId: null }
    }))
  }

  const handleAgentProjectClick = (project) => {
    setSelectedProject(project.id)
    setSelectedProjectType('agent')
    setCurrentVizId(null)
    window.dispatchEvent(new CustomEvent('project:urlUpdate', {
      detail: { projectId: project.id, vizId: null }
    }))
  }

  // Helper to close project and update URL
  const handleCloseProject = () => {
    setSelectedProject(null)
    setSelectedProjectType(null)
    setCurrentVizId(null)
    window.dispatchEvent(new CustomEvent('project:urlUpdate', {
      detail: { projectId: null, vizId: null }
    }))
  }

  // Presentation project view (iframe)
  if (selectedProject && selectedProjectType === 'presentation') {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-green-400">{selectedProject}</h3>
            <p className="text-xs text-muted-foreground">
              {projectCounts[selectedProject]} visualizations
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCloseProject} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
        </div>
        <div className="flex-1 min-h-0">
          <iframe
            src={buildVizUrl(`viz/projects/${selectedProject}/index.html`)}
            className="w-full h-full border-0"
            title={selectedProject}
            sandbox={VIZ_SANDBOX}
            allow="fullscreen; clipboard-write"
          />
        </div>
      </div>
    )
  }

  // Agent project detail view
  if (selectedProject && selectedProjectType === 'agent') {
    const agent = agentProjects.find(a => a.id === selectedProject)
    if (!agent) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          <p>Agent project not found</p>
          <Button variant="ghost" size="sm" onClick={handleCloseProject} className="mt-4">
            Back to Projects
          </Button>
        </div>
      )
    }

    return (
      <div className="h-full flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-blue-400">{agent.name}</h3>
            <p className="text-xs text-muted-foreground">{agent.description}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCloseProject} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <div className="mb-6">
            <h4 className="text-sm font-medium text-muted-foreground mb-3">Tasks</h4>
            <div className="space-y-2">
              {agent.tasks.map((task, idx) => (
                <div key={task.id} className="flex items-center gap-3 p-3 bg-card border border-border">
                  <span className="text-xs text-muted-foreground w-6">{idx + 1}</span>
                  <div className="flex-1">
                    <p className="font-medium">{task.name}</p>
                    <p className="text-xs text-muted-foreground">{task.description}</p>
                  </div>
                  <code className="text-xs text-muted-foreground bg-background px-2 py-1">{task.entry}</code>
                </div>
              ))}
            </div>
          </div>

          {agent.inputs?.data?.length > 0 && (
            <div className="mb-6">
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Data Inputs</h4>
              <div className="flex flex-wrap gap-2">
                {agent.inputs.data.map(d => (
                  <span key={d} className="px-2 py-1 bg-card border border-border text-xs">{d}</span>
                ))}
              </div>
            </div>
          )}

          {agent.outputs?.main && (
            <div className="mb-6">
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Output</h4>
              <code className="text-xs bg-card border border-border px-2 py-1">{agent.outputs.main}</code>
            </div>
          )}

          <div className="mt-8 pt-6 border-t border-border">
            <p className="text-sm text-muted-foreground mb-4">Run tasks from terminal:</p>
            <div className="space-y-2">
              {agent.tasks.map(task => (
                <code key={task.id} className="block text-xs bg-card border border-border px-3 py-2">
                  node projects/{agent.id}/{task.entry}
                </code>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Projects list view
  const hasProjects = presentationProjects.length > 0 || agentProjects.length > 0

  return (
    <div className="p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-green-400">Projects</h2>
        <p className="text-muted-foreground text-sm">Presentation projects and task agents</p>
      </div>

      {loading ? (
        <div className="text-center text-muted-foreground py-12">
          <p>Loading projects...</p>
        </div>
      ) : !hasProjects ? (
        <div className="text-center text-muted-foreground py-12">
          <FolderKanban className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No projects found</p>
          <p className="text-xs mt-2">
            Create a presentation: <code className="bg-card px-1 py-0.5 rounded">viz/projects/name/index.html</code>
          </p>
          <p className="text-xs mt-1">
            Create an agent: <code className="bg-card px-1 py-0.5 rounded">projects/name/agent.json</code>
          </p>
        </div>
      ) : (
        <>
          {/* Agent Projects */}
          {agentProjects.length > 0 && (
            <div className="mb-8">
              <h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
                <Bot className="h-4 w-4" />
                Agent Projects ({agentProjects.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {agentProjects.map(project => (
                  <Card
                    key={project.id}
                    className="group cursor-pointer transition-all hover:border-blue-400/50 overflow-hidden"
                    onClick={() => handleAgentProjectClick(project)}
                  >
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="p-3 bg-blue-400/10 rounded-lg">
                          <Bot className="h-6 w-6 text-blue-400" />
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                      </div>
                      <h3 className="text-lg font-semibold mb-1">{project.name}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-2">{project.description}</p>
                      <p className="text-xs text-muted-foreground mt-2">
                        {project.tasks.length} task{project.tasks.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Presentation Projects */}
          {presentationProjects.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
                <Presentation className="h-4 w-4" />
                Presentation Projects ({presentationProjects.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {presentationProjects.map(project => (
                  <Card
                    key={project}
                    className="group cursor-pointer transition-all hover:border-green-400/50 overflow-hidden"
                    onClick={() => handlePresentationProjectClick(project)}
                  >
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="p-3 bg-green-400/10 rounded-lg">
                          <FolderKanban className="h-6 w-6 text-green-400" />
                        </div>
                        <Presentation className="h-5 w-5 text-muted-foreground group-hover:text-green-400 transition-colors" />
                      </div>
                      <h3 className="text-lg font-semibold mb-1">{project}</h3>
                      <p className="text-sm text-muted-foreground">
                        {projectCounts[project] || 0} visualizations
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
