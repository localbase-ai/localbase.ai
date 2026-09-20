#!/usr/bin/env node

/**
 * Workspace Configuration Manager
 * Manages persistent workspace selection across server restarts
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.localbase');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Current schema version for ~/.localbase/config.json.
 * Bump when adding fields that require migration.
 */
const CONFIG_SCHEMA_VERSION = 1;

/**
 * Default values for fields the user hasn't set yet. Merged into any
 * config read from disk, so newly-added fields appear with sensible
 * defaults without requiring a migration.
 */
const CONFIG_DEFAULTS = {
  version: CONFIG_SCHEMA_VERSION,
  updateChannel: 'stable', // 'stable' | 'nightly' | 'dev'
  telemetry: null,         // null = not yet asked; true/false after prompt
};

/**
 * Root directory where the framework + all instances live.
 * Override with the LOCALBASE_ROOT env var. Defaults to ~/Localbase.
 */
export function localbaseRoot() {
  return process.env.LOCALBASE_ROOT || join(homedir(), 'Localbase');
}

export function isLocalBaseWorkspace(workspacePath) {
  const vizDir = join(workspacePath, 'viz');

  if (existsSync(join(vizDir, 'visualizations.json'))) {
    return true;
  }

  if (!existsSync(vizDir)) {
    return false;
  }

  // Fresh clones may not have a registry yet. Treat a directory with the
  // expected LocalBase structure as a workspace so bootstrap can complete.
  return (
    existsSync(join(workspacePath, 'package.json')) &&
    existsSync(join(workspacePath, 'tools')) &&
    existsSync(join(workspacePath, 'data')) &&
    existsSync(join(workspacePath, 'connectors')) &&
    existsSync(join(workspacePath, 'scripts'))
  );
}

/**
 * Detect available LocalBase workspaces
 * Scans $LOCALBASE_ROOT (default ~/Localbase) for directories containing
 * viz/visualizations.json. Also checks for my-workspace in the framework directory.
 */
export function detectWorkspaces() {
  const workDir = localbaseRoot();
  const workspaces = [];

  try {
    if (!existsSync(workDir)) {
      return workspaces;
    }

    const entries = readdirSync(workDir);

    for (const entry of entries) {
      const fullPath = join(workDir, entry);

      // Check if it's a directory
      if (!statSync(fullPath).isDirectory()) continue;

      // Check for my-workspace in framework (highest priority)
      const myWorkspacePath = join(fullPath, 'my-workspace', 'viz', 'visualizations.json');

      if (existsSync(myWorkspacePath)) {
        // Framework with my-workspace - add my-workspace only, skip the parent
        workspaces.push({
          name: 'my-workspace',
          path: join(fullPath, 'my-workspace')
        });
        // Don't add the framework directory itself
        continue;
      }

      // Check for viz/visualizations.json (current pattern)
      if (isLocalBaseWorkspace(fullPath)) {
        workspaces.push({
          name: entry,
          path: fullPath
        });
      }
    }
  } catch (error) {
    console.error('Error detecting workspaces:', error);
  }

  return workspaces;
}

/**
 * Read workspace config from disk. Returns null if the file doesn't exist
 * or can't be parsed; otherwise the parsed object merged over defaults so
 * newer fields have sensible values when missing.
 */
export function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const data = readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return { ...CONFIG_DEFAULTS, ...parsed };
  } catch (error) {
    console.error('Error reading workspace config:', error);
    return null;
  }
}

/**
 * Write workspace config to disk
 */
export function writeConfig(config) {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing workspace config:', error);
    return false;
  }
}

/**
 * Get the current workspace (from config or default)
 */
export function getCurrentWorkspace() {
  const cwd = process.cwd();
  if (isLocalBaseWorkspace(cwd)) {
    return cwd;
  }

  const config = readConfig();

  if (config && config.currentWorkspace) {
    // Validate that the workspace still exists
    if (isLocalBaseWorkspace(config.currentWorkspace)) {
      return config.currentWorkspace;
    }
  }

  // No valid config - prefer my-workspace if it exists, otherwise use first available
  const workspaces = detectWorkspaces();

  // Prioritize my-workspace as the default
  const myWorkspace = workspaces.find(w => w.name === 'my-workspace');
  if (myWorkspace) {
    return myWorkspace.path;
  }

  // Fall back to first available workspace
  if (workspaces.length > 0) {
    return workspaces[0].path;
  }

  // Fallback to wherever the server is running from
  return process.cwd();
}

/**
 * Set the current workspace
 */
export function setCurrentWorkspace(workspacePath) {
  const config = readConfig() || { ...CONFIG_DEFAULTS };
  config.currentWorkspace = workspacePath;
  config.lastUpdated = new Date().toISOString();

  return writeConfig(config);
}

/**
 * Get config file location
 */
export function getConfigPath() {
  return CONFIG_FILE;
}
