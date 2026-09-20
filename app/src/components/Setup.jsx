import { useState, useEffect } from 'react'
import { CornerDownLeft, Database, Check, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function Setup({ onComplete }) {
  const [availableProjects, setAvailableProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [scanning, setScanning] = useState(false)

  // Scan for LocalBase projects on mount
  useEffect(() => {
    scanForProjects().catch(err => {
      console.error('Failed to scan for projects:', err)
      setScanning(false)
    })
  }, [])

  const scanForProjects = async () => {
    console.log('🔍 Starting project scan...')
    setScanning(true)
    const projects = []

    try {
      if (!window.electronAPI?.files) {
        console.error('electronAPI.files not available')
        setScanning(false)
        return
      }

      const home = await window.electronAPI.files.getHome()
      console.log('🏠 Home directory:', home)

      // Scan common locations
      const locationsToScan = [
        `${home}/Work`,
        home,
      ]

      for (const location of locationsToScan) {
        console.log(`📁 Scanning: ${location}`)
        try {
          const entries = await window.electronAPI.files.listDirectory(location)
          console.log(`  Found ${entries.length} entries`)

          for (const entry of entries) {
            if (entry.isDirectory) {
              const fullPath = `${location}/${entry.name}`

              // Check if this directory is a LocalBase project
              const isLocalBase = await checkIfLocalBaseProject(fullPath)
              if (isLocalBase) {
                console.log(`  ✅ Found LocalBase project: ${entry.name}`)
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

      // Filter out the framework repo (localbase.ai)
      const filteredProjects = projects.filter(p => p.name !== 'localbase.ai')

      console.log(`📊 Total projects found: ${filteredProjects.length}`)
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

      // Must have connectors/, tools/, and package.json
      const hasConnectors = entryNames.includes('connectors')
      const hasTools = entryNames.includes('tools')
      const hasPackageJson = entryNames.includes('package.json')

      return hasConnectors && hasTools && hasPackageJson
    } catch {
      return false
    }
  }

  const handleProjectSelect = async () => {
    console.log('📂 handleProjectSelect called', { selectedProject })

    if (!selectedProject) {
      console.error('No project selected')
      return
    }

    if (!window.electronAPI?.config) {
      console.error('electronAPI.config not available')
      return
    }

    try {
      console.log('💾 Saving project root:', selectedProject.path)
      const result = await window.electronAPI.config.setProjectRoot(selectedProject.path)
      console.log('✅ Project root saved:', result)

      if (onComplete) {
        console.log('🔄 Calling onComplete')
        onComplete({ projectRoot: selectedProject.path })
      }
    } catch (err) {
      console.error('❌ Failed to save project root:', err)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
        <div className="space-y-8">
          {/* Header */}
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center gap-3 text-green-400">
              <Database className="h-8 w-8" />
              <h1 className="text-3xl font-bold font-mono">localbase</h1>
            </div>
            <p className="text-muted-foreground text-base">
              select your workspace
            </p>
          </div>

          {/* Projects List */}
          {scanning ? (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-green-400 mb-4"></div>
              <p className="text-muted-foreground">Scanning for workspaces...</p>
            </div>
          ) : availableProjects.length === 0 ? (
            <div className="text-center space-y-4 py-8">
              <p className="text-muted-foreground">
                No LocalBase workspaces found in ~/Work
              </p>
              <p className="text-sm text-muted-foreground">
                LocalBase projects must contain: connectors/, tools/, and package.json
              </p>
              <Button
                variant="outline"
                onClick={scanForProjects}
                className="mt-4 border-green-400/50 text-green-400 hover:bg-green-400/10"
              >
                Scan Again
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {availableProjects.map((project) => (
                <Card
                  key={project.path}
                  className={`cursor-pointer transition-all hover:scale-[1.02] ${
                    selectedProject?.path === project.path
                      ? 'border-green-400 bg-green-400/10 shadow-lg shadow-green-400/20'
                      : 'border-border hover:border-green-400/50'
                  }`}
                  onClick={() => setSelectedProject(project)}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <div className="flex items-center gap-3">
                        <Database className={`h-5 w-5 ${selectedProject?.path === project.path ? 'text-green-400' : 'text-muted-foreground'}`} />
                        <span className="font-mono">{project.name}</span>
                      </div>
                      {selectedProject?.path === project.path && (
                        <Check className="h-4 w-4 text-green-400" />
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {project.path}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Continue Button */}
          <div className="flex justify-center pt-4">
            <Button
              size="default"
              onClick={handleProjectSelect}
              disabled={!selectedProject}
              className="bg-green-400 text-black hover:bg-green-500 font-mono disabled:opacity-50 disabled:bg-green-400/20 px-8"
            >
              <span>open workspace</span>
              <CornerDownLeft className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
