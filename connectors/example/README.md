# Example Connector

This is a template showing how to build a LocalBase connector following the BaseConnector pattern.

## Connector Structure

Every connector should follow this structure:

```
connectors/example/
├── README.md          # Documentation for the connector
├── index.js           # Main connector implementation
└── update.js          # Optional: Script to sync/update data
```

## BaseConnector Pattern

All connectors must extend the `BaseConnector` class and implement these required methods:

### 1. Constructor
```javascript
import { BaseConnector } from '../MCPAdapter.js';

export class ExampleConnector extends BaseConnector {
  constructor() {
    super('example'); // Pass connector name to parent
    this.dbPath = path.join(process.cwd(), 'data/example/example.db');
  }
}
```

### 2. Required Methods

#### `getTools()`
Returns an array of MCP tool definitions that this connector provides:

```javascript
getTools() {
  return [{
    name: 'example_get_data',
    description: 'Get data from the example connector',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional filter criteria'
        }
      }
    }
  }];
}
```

#### `canHandleTool(toolName)`
Returns `true` if this connector can handle the given tool name:

```javascript
canHandleTool(toolName) {
  return toolName.startsWith('example_');
}
```

#### `handleTool(toolName, args)`
Executes the requested tool operation:

```javascript
async handleTool(toolName, args) {
  try {
    switch (toolName) {
      case 'example_get_data':
        return this.formatResponse(await this.getData(args));
      default:
        return this.formatError(new Error(`Unknown tool: ${toolName}`));
    }
  } catch (error) {
    return this.formatError(error);
  }
}
```

## Database Operations

Use `better-sqlite3` for all SQLite operations:

```javascript
import Database from 'better-sqlite3';

async getData(args) {
  const db = new Database(this.dbPath, { readonly: true });
  try {
    const stmt = db.prepare('SELECT * FROM example_table WHERE status = ?');
    return stmt.all(args.filter);
  } finally {
    db.close();
  }
}
```

## Environment Variables

Load configuration from `env.local` using dotenv:

```javascript
import dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), 'env.local') });

const apiKey = process.env.EXAMPLE_API_KEY;
```

## Error Handling

Use the built-in error formatting:

```javascript
try {
  // Your code here
  return this.formatResponse(data);
} catch (error) {
  return this.formatError(error);
}
```

## MCP Integration

Connectors automatically register with the MCP server. Your tools will be available in Claude Code as:
- `example_get_data`
- `example_update_data`
- etc.

## Example Implementation

See `connectors/example/index.js` for a complete working example.

## Data Storage

Store your data in `data/example/` directory:
```
data/example/
├── example.db         # Main SQLite database
└── cache/             # Optional: Cache files
```

## Update Scripts

Create an `update.js` script for syncing data:

```javascript
import { ExampleConnector } from './index.js';

async function updateData() {
  const connector = new ExampleConnector();
  // Fetch from API
  // Transform data
  // Store in database
}

updateData().catch(console.error);
```

Run with: `node connectors/example/update.js`

## Best Practices

1. **Flat structure** - Keep connector files in a single directory
2. **Single responsibility** - One connector per data source
3. **Error handling** - Always use try/catch and formatError()
4. **Database cleanup** - Always close database connections
5. **Environment config** - Never hardcode credentials
6. **MCP tools** - Provide clear, descriptive tool names and schemas
7. **Documentation** - Keep README.md up to date with examples

## Testing

Test your connector by:
1. Running update script: `node connectors/example/update.js`
2. Checking database: `sqlite3 data/example/example.db`
3. Using MCP tools in Claude Code
4. Verifying data in web dashboard

## Integration Checklist

- [ ] Extends BaseConnector
- [ ] Implements getTools()
- [ ] Implements canHandleTool()
- [ ] Implements handleTool()
- [ ] Uses formatResponse() and formatError()
- [ ] Stores data in data/example/
- [ ] Has README.md with examples
- [ ] Has update.js script
- [ ] Loads config from env.local
- [ ] Properly closes database connections
