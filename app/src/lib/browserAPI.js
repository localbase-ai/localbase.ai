/**
 * Browser API shim - replaces window.electronAPI for browser-only mode
 * Calls the Express API via same-origin relative URLs (Vite proxy in dev, reverse proxy in cloud) instead of Electron IPC
 */

const API_BASE = '';

export const browserAPI = {
  auth: {
    async getSession() {
      const res = await fetch(`${API_BASE}/api/session`, { credentials: 'same-origin' });
      if (res.status === 404) return { preview: false, authenticated: true };
      const data = await res.json().catch(() => ({}));
      return { ...data, preview: data.preview === true, authenticated: res.ok && data.authenticated === true };
    },
    async login(password) {
      const res = await fetch(`${API_BASE}/api/session/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));
      return { ...data, success: res.ok && data.success === true };
    },
    async logout() {
      const res = await fetch(`${API_BASE}/api/session/logout`, { method: 'POST', credentials: 'same-origin' });
      return res.ok;
    }
  },

  config: {
    async getProjectRoot() {
      const res = await fetch(`${API_BASE}/api/workspace`);
      const data = await res.json();
      return data.success ? data.path : null;
    },
    async setProjectRoot(path) {
      const res = await fetch(`${API_BASE}/api/workspace/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });
      const data = await res.json();
      if (data.success) {
        // Notify components that workspace changed
        window.dispatchEvent(new CustomEvent('workspace:changed', { detail: path }));
      }
      return data;
    }
  },

  api: {
    async getVisualizations() {
      const res = await fetch(`${API_BASE}/api/viz`);
      const data = await res.json();
      return data.success ? { success: true, visualizations: data.visualizations, projectsWithPresentation: data.projectsWithPresentation || [], presentationCounts: data.presentationCounts || {}, agentProjects: data.agentProjects || [] } : data;
    },
    async deleteVisualization(id) {
      const res = await fetch(`${API_BASE}/api/viz/${id}`, { method: 'DELETE' });
      return res.json();
    },
    async getTools() {
      const res = await fetch(`${API_BASE}/api/tools`);
      const data = await res.json();
      return data.success ? data : { success: true, tools: [] };
    },
    async getConnectors() {
      const res = await fetch(`${API_BASE}/api/connectors`);
      const data = await res.json();
      return data.success ? data : { success: true, connectors: [] };
    },
    async getDataSources() {
      const res = await fetch(`${API_BASE}/api/datasources`);
      const data = await res.json();
      return data.success ? data : { success: true, dataSources: [] };
    },
    async getToolConfig(toolId) {
      const res = await fetch(`${API_BASE}/api/tools/${toolId}/config`);
      return res.json();
    },
    async readWorkspaceFile(relativePath) {
      const res = await fetch(`${API_BASE}/api/workspace/file?path=${encodeURIComponent(relativePath)}`);
      return res.json();
    },
    async syncDataSource(sourceId) {
      const res = await fetch(`${API_BASE}/api/datasources/${sourceId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      return res.json();
    },
    // The sync above only starts the job and returns; poll this until status
    // leaves 'running'. Syncs can take tens of minutes.
    async getSyncStatus(sourceId) {
      const res = await fetch(`${API_BASE}/api/datasources/${sourceId}/sync-status`);
      return res.json();
    },
    async toggleVizPin(id, pinned) {
      const res = await fetch(`${API_BASE}/api/viz/${id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned })
      });
      return res.json();
    }
  },

  files: {
    async getHome() {
      // In browser mode, return null to signal Home.jsx to use /api/workspaces instead
      return null;
    },
    async listDirectory(path) {
      // Not available in browser mode - Home.jsx should use /api/workspaces
      return [];
    }
  },

  // Workspaces API - browser mode uses this instead of filesystem scanning
  workspaces: {
    async list() {
      const res = await fetch(`${API_BASE}/api/workspaces`);
      return res.json();
    }
  },

  // Workspace management
  workspace: {
    async delete(workspacePath) {
      const res = await fetch(`${API_BASE}/api/workspace`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspacePath })
      });
      return res.json();
    }
  },

  // Terminal is not available in browser mode
  terminal: null,

  // DB queries go through server - matches Electron's hardcoded localbase.db
  db: {
    async query(sql, params = []) {
      const res = await fetch(`${API_BASE}/api/db/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          database: 'data/localbase.db',
          sql,
          params
        })
      });
      const result = await res.json();
      if (result.success) {
        return result.data;
      } else {
        throw new Error(result.error);
      }
    }
  }
};

/**
 * Initialize browser API - call this on app startup
 * Sets window.electronAPI to browserAPI if not in Electron
 */
export function initBrowserAPI() {
  if (typeof window !== 'undefined' && !window.electronAPI) {
    console.log('🌐 Browser mode detected - using browserAPI shim');
    window.electronAPI = browserAPI;
  }
}
