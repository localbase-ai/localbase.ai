import { BaseConnector } from '../MCPAdapter.js';
import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), 'env.local') });

/**
 * Example Connector - Template for building LocalBase connectors
 *
 * This connector demonstrates the BaseConnector pattern and shows
 * how to implement MCP tools for Claude Code integration.
 */
export class ExampleConnector extends BaseConnector {
  constructor() {
    super('example');
    this.dbPath = path.join(process.cwd(), 'data/example/example.db');
  }

  /**
   * Define MCP tools that this connector provides
   * These tools will be available in Claude Code
   */
  getTools() {
    return [
      {
        name: 'example_get_items',
        description: 'Get all items from the example database',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status (active, inactive, all)',
              enum: ['active', 'inactive', 'all']
            },
            limit: {
              type: 'number',
              description: 'Maximum number of items to return',
              default: 100
            }
          }
        }
      },
      {
        name: 'example_get_stats',
        description: 'Get statistics about the example data',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  /**
   * Check if this connector can handle the given tool
   */
  canHandleTool(toolName) {
    return toolName.startsWith('example_');
  }

  /**
   * Execute the requested tool operation
   */
  async handleTool(toolName, args) {
    try {
      switch (toolName) {
        case 'example_get_items':
          return this.formatResponse(await this.getItems(args));

        case 'example_get_stats':
          return this.formatResponse(await this.getStats());

        default:
          return this.formatError(new Error(`Unknown tool: ${toolName}`));
      }
    } catch (error) {
      return this.formatError(error);
    }
  }

  /**
   * Get items from the database
   */
  async getItems(args = {}) {
    const { status = 'all', limit = 100 } = args;

    const db = new Database(this.dbPath, { readonly: true });
    try {
      let query = 'SELECT * FROM items';
      const params = [];

      if (status !== 'all') {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const stmt = db.prepare(query);
      return stmt.all(...params);
    } finally {
      db.close();
    }
  }

  /**
   * Get statistics about the data
   */
  async getStats() {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const totalStmt = db.prepare('SELECT COUNT(*) as total FROM items');
      const total = totalStmt.get();

      const byStatusStmt = db.prepare(`
        SELECT status, COUNT(*) as count
        FROM items
        GROUP BY status
      `);
      const byStatus = byStatusStmt.all();

      return {
        total: total.total,
        byStatus: byStatus.reduce((acc, row) => {
          acc[row.status] = row.count;
          return acc;
        }, {})
      };
    } finally {
      db.close();
    }
  }

  /**
   * Initialize the database schema
   * Call this from your update script
   */
  async initDatabase() {
    const db = new Database(this.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
        CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
      `);
    } finally {
      db.close();
    }
  }
}

// Export singleton instance
export default new ExampleConnector();
