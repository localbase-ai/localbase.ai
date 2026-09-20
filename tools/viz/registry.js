/**
 * Visualization Registry - Automatic visualization tracking and metadata management
 */

import { readFileSync, writeFileSync, unlinkSync, statSync, existsSync, readdirSync } from 'fs';
import { join, basename, normalize } from 'path';

export class VizRegistry {
  constructor(vizDir = 'viz') {
    this.vizDir = vizDir;
    this.registryPath = join(vizDir, 'visualizations.json');
    this.workspace = this.detectWorkspace();
  }

  /**
   * Detect workspace from current working directory
   * Returns: workspace name based on directory structure
   */
  detectWorkspace() {
    const cwd = process.cwd();
    const parts = cwd.split('/');

    // Try to find workspace name from path: look for the LocalBase root marker.
    // Default convention is ~/Localbase/<workspace>/; legacy ~/Work/<workspace>/ still works.
    for (const marker of ['Localbase', 'Work']) {
      const idx = parts.indexOf(marker);
      if (idx >= 0 && idx < parts.length - 1) {
        return parts[idx + 1];
      }
    }

    // Fallback to 'default' workspace
    return 'default';
  }

  /**
   * Register a new visualization
   */
  async register(vizInfo) {
    const registry = this.loadRegistry();

    // Add to registry with metadata
    const vizRecord = {
      id: vizInfo.id || vizInfo.vizId, // Support both new 'id' and legacy 'vizId'
      filename: vizInfo.filename,
      title: vizInfo.title,
      type: vizInfo.type,
      library: vizInfo.library,
      url: vizInfo.url,
      size: vizInfo.size,
      date: vizInfo.date || new Date().toISOString(),
      createdAt: vizInfo.createdAt || new Date().toISOString(),
      workspace: vizInfo.workspace || this.workspace, // Auto-detect workspace
      views: 0,
      lastViewed: null,
      ...(vizInfo.icon && { icon: vizInfo.icon }),
      ...(vizInfo.deploymentUrl && { deploymentUrl: vizInfo.deploymentUrl }),
      ...(vizInfo.domain && { domain: vizInfo.domain }),
      ...(vizInfo.deployed && { deployed: vizInfo.deployed })
    };

    // Remove any existing visualization with same ID or filename
    const vizId = vizInfo.id || vizInfo.vizId;
    registry.visualizations = registry.visualizations.filter(c =>
      (c.id || c.vizId) !== vizId && c.filename !== vizInfo.filename
    );

    // Add new visualization at beginning
    registry.visualizations.unshift(vizRecord);

    // Update metadata
    registry.lastUpdated = new Date().toISOString();
    registry.totalVisualizations = registry.visualizations.length;
    registry.totalViews = registry.visualizations.reduce((sum, c) => sum + (c.views || 0), 0);

    this.saveRegistry(registry);
    console.log(`📊 Visualization registered: ${vizInfo.title}`);

    return vizRecord;
  }

  /**
   * Remove visualization from registry
   */
  async unregister(vizId) {
    const registry = this.loadRegistry();
    const viz = registry.visualizations.find(c => (c.id || c.vizId) === vizId);

    if (!viz) {
      throw new Error(`Visualization not found: ${vizId}`);
    }

    // Remove from filesystem if local
    if (viz.filename && !viz.deployed) {
      try {
        // Prevent path traversal attacks - sanitize filename
        const safeFilename = basename(viz.filename);
        const filePath = join(this.outputDir, safeFilename);

        // Verify the resolved path is still within outputDir
        const normalizedPath = normalize(filePath);
        const normalizedOutputDir = normalize(this.outputDir);
        if (!normalizedPath.startsWith(normalizedOutputDir)) {
          throw new Error('Invalid file path: path traversal detected');
        }

        unlinkSync(filePath);
        console.log(`🗑️  Deleted file: ${safeFilename}`);
      } catch (error) {
        console.warn(`⚠️  Could not delete file: ${viz.filename}`, error.message);
      }
    }

    // Remove from registry
    registry.visualizations = registry.visualizations.filter(c => (c.id || c.vizId) !== vizId);
    registry.lastUpdated = new Date().toISOString();
    registry.totalVisualizations = registry.visualizations.length;

    this.saveRegistry(registry);
    console.log(`📊 Visualization unregistered: ${viz.title}`);

    return viz;
  }

  /**
   * Get visualization by ID
   */
  async get(vizId) {
    const registry = this.loadRegistry();
    return registry.visualizations.find(c => (c.id || c.vizId) === vizId);
  }

  /**
   * Get all visualizations
   */
  async getAll() {
    const registry = this.loadRegistry();
    return registry.visualizations;
  }

  /**
   * Get projects that have presentation pages (index.html in viz/projects/{name}/)
   */
  getProjectsWithPresentation() {
    const projectsDir = join(this.vizDir, 'projects');
    const projectsWithPresentation = [];

    try {
      if (existsSync(projectsDir)) {
        const dirs = readdirSync(projectsDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const indexPath = join(projectsDir, dir.name, 'index.html');
            if (existsSync(indexPath)) {
              projectsWithPresentation.push(dir.name);
            }
          }
        }
      }
    } catch (error) {
      console.warn('Could not read projects directory:', error.message);
    }

    return projectsWithPresentation;
  }

  /**
   * Count presentation pages per project: rendered .html files (excluding the
   * index.html shell) in viz/projects/{name}/. This is what the Projects card
   * shows as the project's size — the registry has no per-project viz entries.
   */
  getPresentationCounts() {
    const projectsDir = join(this.vizDir, 'projects');
    const counts = {};

    try {
      if (existsSync(projectsDir)) {
        const dirs = readdirSync(projectsDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const files = readdirSync(join(projectsDir, dir.name));
            counts[dir.name] = files.filter(f => f.endsWith('.html') && f !== 'index.html').length;
          }
        }
      }
    } catch (error) {
      console.warn('Could not count presentation pages:', error.message);
    }

    return counts;
  }

  /**
   * Get agent projects (projects with agent.json in projects/{name}/)
   */
  getAgentProjects() {
    const projectsDir = 'projects';
    const agentProjects = [];

    try {
      if (existsSync(projectsDir)) {
        const dirs = readdirSync(projectsDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const agentJsonPath = join(projectsDir, dir.name, 'agent.json');
            if (existsSync(agentJsonPath)) {
              try {
                const agentConfig = JSON.parse(readFileSync(agentJsonPath, 'utf8'));
                agentProjects.push({
                  id: dir.name,
                  name: agentConfig.name || dir.name,
                  description: agentConfig.description || '',
                  version: agentConfig.version || '1.0.0',
                  tasks: agentConfig.tasks || [],
                  inputs: agentConfig.inputs || {},
                  outputs: agentConfig.outputs || {}
                });
              } catch (parseError) {
                console.warn(`Could not parse agent.json for ${dir.name}:`, parseError.message);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Could not read projects directory:', error.message);
    }

    return agentProjects;
  }

  /**
   * Get visualizations by type
   */
  async getByType(type) {
    const registry = this.loadRegistry();
    return registry.visualizations.filter(c => c.type === type);
  }

  /**
   * Get visualizations by library
   */
  async getByLibrary(library) {
    const registry = this.loadRegistry();
    return registry.visualizations.filter(c => c.library === library);
  }

  /**
   * Get visualizations by workspace (with validation warnings)
   */
  async getByWorkspace(workspace = null) {
    const registry = this.loadRegistry();
    const targetWorkspace = workspace || this.workspace;

    // Filter visualizations by workspace
    const matchingViz = registry.visualizations.filter(v => v.workspace === targetWorkspace);

    // Warn about visualizations without workspace metadata
    const noWorkspace = registry.visualizations.filter(v => !v.workspace);
    if (noWorkspace.length > 0) {
      console.warn(`⚠️  Found ${noWorkspace.length} visualizations without workspace metadata`);
    }

    // Warn about visualizations from other workspaces
    const wrongWorkspace = registry.visualizations.filter(v => v.workspace && v.workspace !== targetWorkspace);
    if (wrongWorkspace.length > 0) {
      console.warn(`⚠️  Found ${wrongWorkspace.length} visualizations from other workspaces:`,
        wrongWorkspace.map(v => `${v.title} (${v.workspace})`).join(', '));
    }

    return matchingViz;
  }

  /**
   * Update visualization metadata
   */
  async updateVisualization(vizId, updates) {
    const registry = this.loadRegistry();
    const viz = registry.visualizations.find(c => (c.id || c.vizId) === vizId);

    if (viz) {
      Object.assign(viz, updates);
      registry.lastUpdated = new Date().toISOString();
      this.saveRegistry(registry);
      return viz;
    }

    return null;
  }

  /**
   * Update visualization views
   */
  async recordView(vizId) {
    const registry = this.loadRegistry();
    const viz = registry.visualizations.find(c => c.vizId === vizId);

    if (viz) {
      viz.views = (viz.views || 0) + 1;
      viz.lastViewed = new Date().toISOString();

      registry.totalViews = registry.visualizations.reduce((sum, c) => sum + (c.views || 0), 0);
      registry.lastUpdated = new Date().toISOString();

      this.saveRegistry(registry);
      return viz;
    }

    return null;
  }

  /**
   * Clean up old visualizations (keep most recent N)
   */
  async cleanup(keepCount = 10) {
    const registry = this.loadRegistry();

    if (registry.visualizations.length <= keepCount) {
      console.log(`📊 Registry clean: ${registry.visualizations.length} visualizations (no cleanup needed)`);
      return;
    }

    // Sort by creation date (newest first)
    registry.visualizations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Get charts to remove
    const visualizationsToRemove = registry.visualizations.slice(keepCount);
    const visualizationsToKeep = registry.visualizations.slice(0, keepCount);

    // Remove old visualizations
    for (const viz of visualizationsToRemove) {
      try {
        await this.unregister(viz.vizId);
      } catch (error) {
        console.warn(`⚠️  Failed to remove visualization: ${viz.vizId}`);
      }
    }

    console.log(`🧹 Cleaned up ${visualizationsToRemove.length} old visualizations, kept ${visualizationsToKeep.length}`);
  }

  /**
   * Sync registry with filesystem
   */
  async sync() {
    const registry = this.loadRegistry();
    const fs = await import('fs/promises');

    try {
      const files = await fs.readdir(this.outputDir);
      const htmlFiles = files.filter(f => f.endsWith('.html') && f !== 'index.html' && f !== 'charts-index.html');

      let updated = false;

      // Check for missing files in registry
      for (const file of htmlFiles) {
        const exists = registry.visualizations.some(c => c.filename === file);
        if (!exists) {
          console.log(`📊 Found unregistered visualization: ${file}`);
          // Add basic entry for unregistered files
          const filePath = join(this.outputDir, file);
          const stats = statSync(filePath);

          await this.register({
            vizId: file.replace('.html', ''),
            filename: file,
            title: file.replace('.html', '').replace(/-/g, ' '),
            type: 'unknown',
            library: 'unknown',
            url: `/visualization/${file}`,
            size: stats.size,
            date: stats.birthtime.toISOString()
          });

          updated = true;
        }
      }

      // Check for deleted files in registry
      for (const viz of registry.visualizations) {
        if (viz.filename && !viz.deployed) {
          const filePath = join(this.outputDir, viz.filename);
          try {
            statSync(filePath);
          } catch {
            console.log(`📊 Visualization file deleted: ${viz.filename}`);
            registry.visualizations = registry.visualizations.filter(c => c.vizId !== viz.vizId);
            updated = true;
          }
        }
      }

      if (updated) {
        registry.lastUpdated = new Date().toISOString();
        registry.totalVisualizations = registry.visualizations.length;
        this.saveRegistry(registry);
        console.log(`📊 Registry synced with filesystem`);
      }

    } catch (error) {
      console.warn(`⚠️  Failed to sync registry: ${error.message}`);
    }
  }

  /**
   * Load registry from disk
   */
  loadRegistry() {
    try {
      const data = readFileSync(this.registryPath, 'utf8');
      return JSON.parse(data);
    } catch {
      // Create default registry
      return {
        visualizations: [],
        lastUpdated: new Date().toISOString(),
        totalVisualizations: 0,
        totalViews: 0,
        version: '1.0'
      };
    }
  }

  /**
   * Save registry to disk
   */
  saveRegistry(registry) {
    writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));
  }

  /**
   * Get registry statistics
   */
  async getStats() {
    const registry = this.loadRegistry();

    const typeStats = {};
    const libraryStats = {};

    for (const viz of registry.visualizations) {
      typeStats[viz.type] = (typeStats[viz.type] || 0) + 1;
      libraryStats[viz.library] = (libraryStats[viz.library] || 0) + 1;
    }

    return {
      totalVisualizations: registry.totalVisualizations,
      totalViews: registry.totalViews,
      lastUpdated: registry.lastUpdated,
      typeBreakdown: typeStats,
      libraryBreakdown: libraryStats,
      recentVisualizations: registry.visualizations.slice(0, 5)
    };
  }
}