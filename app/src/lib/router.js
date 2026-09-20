/**
 * Router - URL parsing and building for LocalBase navigation
 *
 * Handles mapping between URL paths and app views:
 *   /                    → chat (default)
 *   /chat                → chat
 *   /visualizations      → visualizations gallery
 *   /viz/:id             → specific visualization
 *   /projects            → projects list
 *   /project/:id         → specific project
 *   /project/:id/:vizId  → specific viz within a project
 *   /settings            → settings
 *
 * Also supports legacy query params (?viz=, ?project=) for backwards compat.
 */

export const VIEWS = ['home', 'visualizations', 'projects', 'settings'];

// Visualization IDs are stored in the registry without a file extension, but
// URLs like /viz/foo.html (e.g. copied from the address bar or the registry's
// stored `url` field) should still resolve to the bare ID `foo`.
function stripHtml(segment) {
  if (!segment) return null;
  return segment.replace(/\.html$/, '');
}

/**
 * Parse a URL into view state
 * @param {string} url - Full URL or path (e.g., '/viz/deal-velocity' or 'http://localhost/viz/deal-velocity')
 * @returns {{ view: string, vizId: string|null, projectId: string|null }}
 */
export function parseUrl(url) {
  let path = url;
  let search = '';

  // Handle full URLs
  try {
    const parsed = new URL(url, 'http://localhost');
    path = parsed.pathname;
    search = parsed.search;
  } catch {
    // Already a path, check for query string
    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
      path = url.substring(0, queryIndex);
      search = url.substring(queryIndex);
    }
  }

  // Check legacy query params first
  const params = new URLSearchParams(search);
  const vizParam = params.get('viz');
  const projectParam = params.get('project');

  if (vizParam) {
    return { view: 'visualizations', vizId: vizParam, projectId: null };
  }
  if (projectParam) {
    return { view: 'projects', vizId: null, projectId: projectParam };
  }

  // Parse path
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) {
    // Bare root → the welcome / workspace-picker (home) view
    return { view: 'home', vizId: null, projectId: null };
  }

  const first = segments[0];

  switch (first) {
    case 'home':
      return { view: 'home', vizId: null, projectId: null };

    case 'visualizations':
      return { view: 'visualizations', vizId: null, projectId: null };

    case 'viz':
      return {
        view: 'visualizations',
        vizId: stripHtml(segments[1]),
        projectId: null
      };

    case 'projects':
      return { view: 'projects', vizId: null, projectId: null };

    case 'project':
      return {
        view: 'projects',
        vizId: stripHtml(segments[2]),
        projectId: segments[1] || null
      };

    case 'settings':
      return { view: 'settings', vizId: null, projectId: null };

    default:
      // Unknown path → fall back to the welcome / workspace-picker
      return { view: 'home', vizId: null, projectId: null };
  }
}

/**
 * Build a URL from view state
 * @param {string} view - View name (home, visualizations, projects, settings)
 * @param {string|null} vizId - Visualization ID (optional)
 * @param {string|null} projectId - Project ID (optional)
 * @returns {string} URL path
 */
export function buildUrl(view, vizId = null, projectId = null) {
  switch (view) {
    case 'home':
      return '/';

    case 'visualizations':
      return vizId ? `/viz/${vizId}` : '/visualizations';

    case 'projects':
      if (projectId && vizId) {
        return `/project/${projectId}/${vizId}`;
      }
      return projectId ? `/project/${projectId}` : '/projects';

    case 'settings':
      return '/settings';

    default:
      return '/';
  }
}
