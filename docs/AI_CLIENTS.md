# AI client setup

LocalBase has two separate interfaces:

- The local operator server and browser app run on loopback for trusted local use.
- The MCP server exposes connector tools over stdio to an AI client launched from a
  workspace checkout.

The authenticated preview server is a read-only browser surface. It does not turn
the operator API into a remote editing API. Use Claude Code, Codex, or a terminal
on the host when files or connector code need to change.

## Claude Code

From the workspace directory:

```bash
claude mcp add --scope project localbase -- node tools/mcp/server.js
claude mcp list
```

The project-scoped registration keeps the server tied to that checkout. Start
Claude Code from the same directory so connector discovery and relative paths use
the intended workspace.

## Claude Desktop

Add a server entry to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "localbase": {
      "command": "node",
      "args": ["/absolute/path/to/localbase.ai/tools/mcp/server.js"],
      "cwd": "/absolute/path/to/localbase.ai"
    }
  }
}
```

Desktop can ask questions and call the tools the workspace exposes. It should be
treated as a limited client: editing files, creating connectors, and changing the
workspace belongs in Claude Code or a terminal.

## Codex and other MCP clients

Configure an stdio MCP server with the equivalent values:

```text
command: node
arguments: /absolute/path/to/localbase.ai/tools/mcp/server.js
working directory: /absolute/path/to/localbase.ai
```

The MCP protocol is client-neutral. Only the client configuration format changes.

## Remote preview

For a browser-only view, build the app and start the authenticated preview server:

```bash
npm run build
node tools/preview/server.js \
  --workspace /absolute/path/to/workspace \
  --credentials /absolute/path/to/workspace/data/preview/auth.json \
  --port 9232
```

Put that port behind Cloudflare Tunnel, an SSH tunnel, or a private VPN. The preview
server protects workspace reads with a password session, blocks operator mutations,
and serves visualizations and presentations read-only. Never expose the operator API
with `LOCALBASE_ALLOW_REMOTE=true` as a substitute for the preview server.
