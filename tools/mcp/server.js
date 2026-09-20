#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { parse } from 'csv-parse/sync';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory first
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from env.local (relative to project root)
config({ path: path.join(__dirname, '..', '..', 'env.local') });

// Built-in tool names are reserved: a connector may not shadow them.
const BUILTIN_TOOLS = new Set([
  'list_datasets', 'get_data_summary', 'query_csv_data', 'generate_chart',
]);

/**
 * LocalBase Insights MCP Server
 * Basic server for fresh installations - exposes core data querying capabilities
 */
class LocalBaseMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'localbase-insights-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  /**
   * Discover and load `connectors/<name>/index.js`.
   *
   * Connectors are the reason this server is interesting — without this, the
   * only tools on offer are the CSV helpers below, and every synced SQLite
   * database in `data/` is invisible to an MCP client.
   *
   * Loading is deliberately forgiving, because `index.js` is not a reliable
   * signal on its own. Across shipped connectors it has meant at least four
   * different things: a BaseConnector instance (`export default new X()`), a
   * BaseConnector class (`export class X` / `export default X`), an unrelated
   * service class, and a bag of formatter functions. So rather than trust the
   * filename, every export is duck-typed for `getTools` + `handleTool` and
   * anything else is skipped. A connector that throws on import is skipped too
   * — one broken connector must not take the whole server down.
   *
   * Everything here logs to **stderr**. stdout is the MCP protocol channel on a
   * stdio transport, and a stray console.log corrupts the stream.
   */
  async loadConnectors() {
    if (this._connectors) return this._connectors;

    const { readdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const dir = path.join(__dirname, '..', '..', 'connectors');
    const loaded = [];
    const byTool = new Map();

    let entries = [];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      this._connectors = { connectors: [], tools: [], byTool };
      return this._connectors;
    }

    for (const name of entries) {
      const entry = path.join(dir, name, 'index.js');
      if (!existsSync(entry)) continue;

      let mod;
      try {
        mod = await import(`file://${entry}`);
      } catch (error) {
        console.error(`[mcp] ${name}: index.js failed to import — ${error.message}`);
        continue;
      }

      const instance = this.#instantiate(mod, name);
      if (!instance) continue;

      let tools;
      try {
        tools = await instance.getTools();
      } catch (error) {
        console.error(`[mcp] ${name}: getTools() threw — ${error.message}`);
        continue;
      }
      if (!Array.isArray(tools) || tools.length === 0) {
        console.error(`[mcp] ${name}: getTools() returned no tools, skipping`);
        continue;
      }

      const accepted = [];
      for (const tool of tools) {
        if (!tool?.name) continue;
        if (BUILTIN_TOOLS.has(tool.name)) {
          console.error(`[mcp] ${name}: tool "${tool.name}" collides with a built-in, skipping`);
          continue;
        }
        if (byTool.has(tool.name)) {
          console.error(`[mcp] ${name}: tool "${tool.name}" already provided by `
            + `${byTool.get(tool.name).name}, skipping`);
          continue;
        }
        byTool.set(tool.name, { name, instance });
        accepted.push(tool);
      }

      if (accepted.length) {
        loaded.push({ name, instance, tools: accepted });
        console.error(`[mcp] ${name}: ${accepted.length} tool(s) — `
          + accepted.map((x) => x.name).join(', '));
      }
    }

    this._connectors = {
      connectors: loaded,
      tools: loaded.flatMap((c) => c.tools),
      byTool,
    };
    return this._connectors;
  }

  /**
   * Turn whatever a connector module exported into something with `getTools`.
   * Tries the default export first, then named exports; instantiates classes,
   * uses objects as-is, and rejects anything missing the contract.
   */
  #instantiate(mod, name) {
    const candidates = [mod.default, ...Object.values(mod)].filter(Boolean);

    for (const candidate of candidates) {
      let obj = candidate;
      if (typeof candidate === 'function') {
        // A class needs constructing; a plain factory function does not qualify.
        try {
          obj = new candidate();
        } catch {
          continue;
        }
      }
      if (obj && typeof obj.getTools === 'function' && typeof obj.handleTool === 'function') {
        return obj;
      }
    }

    console.error(`[mcp] ${name}: index.js exports nothing implementing `
      + 'getTools()/handleTool() — not an MCP connector, skipping');
    return null;
  }

  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const builtins = [
          {
            name: 'list_datasets',
            description: 'List all available datasets in the data directory',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_data_summary',
            description: 'Get a summary of a specific dataset (columns, row count, etc.)',
            inputSchema: {
              type: 'object',
              properties: {
                dataset: {
                  type: 'string',
                  description: 'Dataset name to summarize',
                },
              },
              required: ['dataset'],
            },
          },
          {
            name: 'query_csv_data',
            description: 'Query data from CSV files in the data directory',
            inputSchema: {
              type: 'object',
              properties: {
                dataset: {
                  type: 'string',
                  description: 'Dataset to query (e.g., "sales-data", "customers")',
                },
                query: {
                  type: 'string',
                  description: 'Natural language query about the data',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of rows to return (default: 10)',
                  default: 10,
                },
              },
              required: ['dataset', 'query'],
            },
          },
          {
            name: 'generate_chart',
            description: 'Generate a basic chart from data',
            inputSchema: {
              type: 'object',
              properties: {
                chartType: {
                  type: 'string',
                  enum: ['line', 'bar', 'pie', 'scatter'],
                  description: 'Type of chart to generate',
                },
                data: {
                  type: 'array',
                  description: 'Array of data points for the chart',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      value: { type: 'number' },
                    },
                  },
                },
                title: {
                  type: 'string',
                  description: 'Chart title',
                },
              },
              required: ['chartType', 'data'],
            },
          },
      ];

      // Connector tools are appended rather than merged: built-ins are reserved
      // (see BUILTIN_TOOLS) so the two sets cannot collide by the time we get here.
      const { tools: connectorTools } = await this.loadConnectors();
      return { tools: [...builtins, ...connectorTools] };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Connector tools first. Dispatch is driven by the name->connector map
        // built from getTools(), not by canHandleTool(): the base class default
        // returns false, so a connector that declares tools but never overrides
        // it would advertise tools it then refuses to run.
        const { byTool } = await this.loadConnectors();
        const owner = byTool.get(name);
        if (owner) return await owner.instance.handleTool(name, args ?? {});

        switch (name) {
          case 'list_datasets':
            return await this.listDatasets();

          case 'get_data_summary':
            return await this.getDataSummary(args.dataset);

          case 'query_csv_data':
            return await this.queryCsvData(args.dataset, args.query, args.limit);

          case 'generate_chart':
            return await this.generateChart(args.chartType, args.data, args.title);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async listDatasets() {
    const { readdir } = await import('fs/promises');
    const dataPath = path.join(__dirname, '..', '..', 'data');

    try {
      const items = await readdir(dataPath, { withFileTypes: true });
      const datasets = items
        .filter(item => item.isDirectory())
        .map(dir => dir.name)
        .sort();

      // Also look for CSV files in root data directory
      const csvFiles = items
        .filter(item => item.isFile() && item.name.endsWith('.csv'))
        .map(file => file.name.replace('.csv', ''));

      const allDatasets = [...datasets, ...csvFiles];

      return {
        content: [
          {
            type: 'text',
            text: allDatasets.length > 0
              ? `Available datasets:\n${allDatasets.map(d => `• ${d}`).join('\n')}`
              : 'No datasets found. Add CSV files or directories to the data/ folder.',
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `No data directory found. Create a 'data/' folder and add CSV files to get started.`,
          },
        ],
      };
    }
  }

  async getDataSummary(dataset) {
    const dataPath = path.join(__dirname, '..', '..', 'data');

    try {
      const { readdir, stat } = await import('fs/promises');

      // Check if it's a directory or CSV file
      const datasetPath = path.join(dataPath, dataset);
      const csvPath = path.join(dataPath, `${dataset}.csv`);

      let filePath;
      let isDirectory = false;

      try {
        const stats = await stat(datasetPath);
        if (stats.isDirectory()) {
          // Look for CSV files in the directory
          const files = await readdir(datasetPath);
          const csvFiles = files.filter(f => f.endsWith('.csv'));

          if (csvFiles.length === 0) {
            throw new Error(`No CSV files found in dataset directory: ${dataset}`);
          }

          filePath = path.join(datasetPath, csvFiles[0]);
          isDirectory = true;
        } else {
          filePath = datasetPath;
        }
      } catch {
        // Try as CSV file
        filePath = csvPath;
        await stat(csvPath); // This will throw if file doesn't exist
      }

      // Read and analyze the CSV
      const content = await readFile(filePath, 'utf-8');
      const rows = parse(content, { columns: true });

      const summary = {
        dataset,
        type: isDirectory ? 'directory' : 'file',
        totalRows: rows.length,
        columns: Object.keys(rows[0] || {}),
        sampleData: rows.slice(0, 3),
      };

      return {
        content: [
          {
            type: 'text',
            text: `Dataset: ${dataset}\n` +
                  `Type: ${summary.type}\n` +
                  `Rows: ${summary.totalRows}\n` +
                  `Columns: ${summary.columns.join(', ')}\n\n` +
                  `Sample data:\n${JSON.stringify(summary.sampleData, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to get summary for ${dataset}: ${error.message}`);
    }
  }

  async queryCsvData(dataset, query, limit = 10) {
    const dataPath = path.join(__dirname, '..', '..', 'data');

    try {
      const { readdir, stat } = await import('fs/promises');

      // Find the CSV file
      const datasetPath = path.join(dataPath, dataset);
      const csvPath = path.join(dataPath, `${dataset}.csv`);

      let filePath;

      try {
        const stats = await stat(datasetPath);
        if (stats.isDirectory()) {
          const files = await readdir(datasetPath);
          const csvFiles = files.filter(f => f.endsWith('.csv'));
          if (csvFiles.length === 0) {
            throw new Error(`No CSV files found in dataset: ${dataset}`);
          }
          filePath = path.join(datasetPath, csvFiles[0]);
        } else {
          filePath = datasetPath;
        }
      } catch {
        filePath = csvPath;
        await stat(csvPath);
      }

      // Read and parse CSV
      const content = await readFile(filePath, 'utf-8');
      const rows = parse(content, { columns: true });

      // Simple filtering based on query keywords
      let filteredRows = rows;
      const queryLower = query.toLowerCase();

      if (queryLower.includes('recent') || queryLower.includes('latest')) {
        filteredRows = rows.slice(-limit);
      } else if (queryLower.includes('first') || queryLower.includes('earliest')) {
        filteredRows = rows.slice(0, limit);
      } else {
        filteredRows = rows.slice(0, limit);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Query: "${query}"\n` +
                  `Dataset: ${dataset}\n` +
                  `Results (${filteredRows.length} rows):\n\n` +
                  JSON.stringify(filteredRows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to query ${dataset}: ${error.message}`);
    }
  }

  async generateChart(chartType, data, title = 'Chart') {
    // For now, return a text representation
    // TODO: Integrate with visualization system

    const chartData = data.map(d => `${d.label}: ${d.value}`).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Chart: ${title}\n` +
                `Type: ${chartType}\n\n` +
                `Data:\n${chartData}\n\n` +
                `[Chart generation with visualization system integration coming next...]`,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('LocalBase Insights MCP Server running on stdio');
    const { connectors, tools } = await this.loadConnectors();
    console.error(`Built-in tools: ${[...BUILTIN_TOOLS].join(', ')}`);
    console.error(connectors.length
      ? `Connectors: ${connectors.map((c) => `${c.name} (${c.tools.length})`).join(', ')} `
        + `— ${tools.length} tool(s)`
      : 'Connectors: none found (no connectors/*/index.js implementing getTools/handleTool)');
  }
}

// Start the server
const server = new LocalBaseMCPServer();
server.run().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});