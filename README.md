# LocalBase

> **🚧 Work in Progress** - This project is under active development. APIs and features may change. Contributions welcome!

> **⚠️ Security Notice:** The local operator server is trusted-machine software: it binds to loopback and does not provide user accounts. The optional preview server is a separate, read-only surface with password authentication and is the supported way to share a workspace remotely. Do not expose the operator server directly. See [Security](#security) below.

**Local-first analytics workspace for your business**

Query your business data with AI. Your data stays on your machine - no cloud dashboards, no SaaS subscriptions.

## How It Works

LocalBase runs a local web server on your machine. Your data lives in SQLite databases on your hard drive. When you open `http://localhost:9221`, you're connecting to a server running on your own computer - not a cloud service. If you need to share visualizations, run the authenticated preview server and put it behind a tunnel or private network.

This means:
- Your databases stay on your machine
- No SaaS accounts or monthly fees
- No third-party analytics platforms seeing your data
- You own everything

**Note:** When you use AI features (Chat, Claude Code), the data you query gets sent to Claude. Claude sees whatever you ask about - not your entire database, but the specific data in your prompts and results.

## Quickstart (developers)

If you already have Node.js and Git:

```bash
gh repo clone localbase-ai/localbase.ai
cd localbase.ai
npm install && (cd app && npm install)
npm run dev
```

Open `http://localhost:9221`. The Express API runs on `:9220`, Vite dev server on `:9221`.
Set `LOCALBASE_API_PORT` / `LOCALBASE_APP_PORT` to move them.

New to terminals, Node, or GitHub? Follow [Getting Started](#getting-started) below for a step-by-step walkthrough.

## Getting Started

### Step 1: Create a GitHub Account

If you don't have one already, sign up at [github.com](https://github.com). This is where the code lives.

### Step 2: Open Terminal

On Mac, press `Cmd + Space`, type "Terminal", and hit Enter. You'll see a window with a blinking cursor - this is where you'll type commands.

Don't worry, you can't break anything. If something goes wrong, just close the window and open a new one.

### Step 3: Get Comfortable with Basic Commands

Try these to get a feel for it:

- `ls` - Lists files in the current folder
- `cd Documents` - Moves into the Documents folder
- `cd ..` - Moves back up one folder
- `pwd` - Shows where you are

That's it. You now know enough terminal to continue.

### Step 4: Install the Tools

Copy and paste these one at a time. Each one installs something you'll need:

**Install Homebrew** (a tool that installs other tools):
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Install GitHub CLI:**
```
brew install gh
```

**Install Node.js:**
```
brew install node
```

**Install Claude Code:**

Visit [claude.ai/code](https://claude.ai/code) and follow the instructions.

### Step 5: Log into GitHub

Run this command:
```
gh auth login
```

It will ask you some questions - just follow the prompts. It opens your browser to complete the login.

### Step 6: Download LocalBase

Now you can grab the code:
```
gh repo clone localbase-ai/localbase.ai
cd localbase.ai
npm install
```

### Step 7: Start It Up

```
npm run dev
```

Open [http://localhost:9221](http://localhost:9221) in your browser. You're in.

## How to Use This

Pick your style:

| Mode | Setup | Who it's for |
|------|-------|--------------|
| **Browser** | Everything in one window | Just want to ask questions and see answers |
| **Split** | Terminal left, browser right | The default. Ask Claude, see results update live |
| **Code** | Terminal left, terminal right | Building connectors, customizing, power users |

Start with Browser mode. When you're ready for more control, open a terminal next to your browser. When you want to build things, go full terminal.

There's no wrong way. The terminal isn't scary - you've just been told it is.

## Data Setup

The `data/` folder contains your SQLite databases and local runtime configuration. Business data and live workspace config stay local and are gitignored.

To set up:
1. Copy `env.local.example` to `env.local` and add your API credentials
2. Copy `data/data-sources.example.json` to `data/data-sources.local.json` and adjust it for your workspace
3. Run a connector to sync data: `node connectors/example/sync.js`
4. Or ask Claude: "Help me create a connector for [service name]"

## The Dashboard

The web UI gives you:

- **Visualizations** - Browse and interact with charts
- **Projects** - Organize related visualizations
- **Settings** - See connected data sources and sync status

## Using with Claude Code

For natural-language analysis, work from the terminal:

```bash
claude   # Start Claude Code in your LocalBase directory
```

Then ask:
- "Show me revenue for Q4"
- "Create a chart of deals by stage"
- "Sync my data"

Claude Code queries the same local databases the dashboard reads from.

## Connecting AI clients

LocalBase exposes connector tools through a standard MCP server over stdio. The MCP
process runs from the workspace directory, so it only discovers connectors and
configuration for that checkout.

### Claude Code

From the LocalBase directory, add the server to the project scope:

```bash
claude mcp add --scope project localbase -- node tools/mcp/server.js
```

Use `claude mcp list` to confirm the server is registered. Claude Code can inspect
the workspace and run exposed connector tools. File edits remain under Claude
Code's normal terminal and approval workflow.

### Claude Desktop

Claude Desktop can connect to the same stdio server. Add this entry to its MCP
configuration file (`claude_desktop_config.json`), using absolute paths:

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

Desktop is useful for asking questions and interacting with exposed MCP tools. Use
Claude Code or a terminal when you need to edit files, create connectors, or change
the workspace.

### Codex and other MCP clients

Codex and other MCP-capable clients use the same stdio contract. Register this
command in the client's MCP settings:

```text
command: node
arguments: /absolute/path/to/localbase.ai/tools/mcp/server.js
working directory: /absolute/path/to/localbase.ai
```

The command is intentionally model-agnostic. Keep the working directory and paths
tied to the workspace the client is allowed to inspect.

## Creating Visualizations

Ask Claude to create a visualization and it will:
1. Create a standalone HTML file in `viz/`
2. Register it in `viz/visualizations.json`
3. Use ApexCharts for interactive charts

Visualizations are self-contained HTML files that query your local databases via the Express API.

## Adding Connectors

Connectors sync data from external APIs into local SQLite databases.

```bash
cp -R connectors/example connectors/mydata
# Edit connectors/mydata/index.js
node connectors/mydata/sync.js
```

Or ask Claude: "Help me create a connector for [service name]"

## Project Structure

```
localbase.ai/
├── app/             # Browser UI (Vite + React)
├── connectors/      # Data source connectors
├── tools/           # Express API + MCP server
├── scripts/         # Utility scripts
├── viz/             # Visualization HTML files
├── test/            # Test suite
└── data/            # SQLite databases (gitignored)
```

## Development

```bash
npm run dev          # Start dev server (API + UI)
npm test             # Run test suite
npm run test:browser # Build and run the authenticated browser smoke test
npm start            # Start API server only
```

The browser smoke test uses Playwright and Chromium. Install the browser once
on a development machine with `npx playwright install chromium`.

## Stack

- **Node.js 18+** - Runtime
- **SQLite** - Local database (better-sqlite3)
- **Express** - API server
- **Vite + React** - Dashboard UI
- **ApexCharts** - Visualizations
- **MCP** - Claude integration protocol

## Security

The local operator server has no user accounts, sessions, or API tokens. Its
security model is network isolation: the server is reachable only from the machine
it runs on. The preview server is a separate process with a workspace password and
read-only routes for visualizations, presentations, connector metadata, and safe
data-source metadata.

That is enforced in layers, so a mistake in any one of them is not on its own
enough to expose your data:

- **Loopback bind.** The listener binds `127.0.0.1`, so it is not reachable from
  other machines at the socket level.
- **Local-only middleware.** Requests are rejected unless they come from a real
  loopback address — `::1` or anything in `127.0.0.0/8` — matched exactly rather
  than by substring.
- **CORS** is restricted to `localhost` and `127.0.0.1` origins, so a page on
  another site cannot read responses from your server.
- **CSRF.** Mutating methods require an `Origin` or `Referer` matching an
  allowed origin.
- **Read-only SQL.** `/api/db/query` opens SQLite read-only, rejects anything
  that is not a read, resolves database paths inside the workspace data
  directory, and uses parameterized statements.
- **Rate limiting**, 200 requests per minute per address.
- **Security headers**: `X-Frame-Options`, `X-Content-Type-Options`,
  `X-XSS-Protection`.

### Exposing the operator server deliberately

`LOCALBASE_ALLOW_REMOTE=true` binds all interfaces and turns off the local-only
check. Nothing authenticates behind it, so anything that can reach the port can
read and modify your data. Do not use this for a shared deployment.

### Sharing a read-only preview

Build the app, choose a strong workspace password, and start the preview server:

```bash
npm run build
node tools/preview/server.js \
  --workspace /absolute/path/to/workspace \
  --credentials /absolute/path/to/workspace/data/preview/auth.json \
  --port 9232
```

The preview server authenticates every data and visualization read, blocks operator
mutations, refuses path traversal, sets secure session cookies behind HTTPS, and
serves the app shell so the login appears inside the LocalBase Home screen. Put it
behind Cloudflare Tunnel, an SSH tunnel, or a private VPN. It is intentionally
read-only; use Claude Code or a terminal for file edits.

### What still leaves your machine

AI features are the exception to "nothing leaves your machine". When you use
Chat or Claude Code, the data in your prompts and results is sent to Claude.

## Requirements

- Node.js 18+
- Claude Code or Claude Desktop (for AI features)
