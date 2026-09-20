#!/bin/bash
# LocalBase Instance Bootstrap Script
# Creates a new LocalBase instance workspace
#
# By convention: framework + all instances live under $LOCALBASE_ROOT
# (default ~/Localbase). Override LOCALBASE_ROOT to install elsewhere.

set -e

FRAMEWORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCALBASE_ROOT="${LOCALBASE_ROOT:-$HOME/Localbase}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🚀 LocalBase Instance Bootstrap${NC}"
echo ""

# Get instance name
if [ -z "$1" ]; then
  echo "Usage: ./bootstrap-instance.sh <instance-name>"
  echo ""
  echo "Example: ./bootstrap-instance.sh my-company"
  echo ""
  echo "Instance is created at \$LOCALBASE_ROOT/<instance-name> (default ~/Localbase/<instance-name>)."
  exit 1
fi

INSTANCE_NAME=$1
INSTANCE_DIR="$LOCALBASE_ROOT/$INSTANCE_NAME"

# Check if instance already exists
if [ -d "$INSTANCE_DIR" ]; then
  echo -e "${YELLOW}⚠️  Instance directory already exists: $INSTANCE_DIR${NC}"
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
else
  echo -e "${GREEN}Creating new instance: $INSTANCE_NAME${NC}"
  mkdir -p "$INSTANCE_DIR"
fi

cd "$INSTANCE_DIR"

# 1. Initialize git
echo -e "${BLUE}📦 Initializing git...${NC}"
if [ ! -d ".git" ]; then
  git init
  echo "✓ Git initialized"
else
  echo "✓ Git already initialized"
fi

# 2. Create instance-specific directories
echo -e "${BLUE}📁 Creating directory structure...${NC}"
mkdir -p connectors
mkdir -p data
mkdir -p projects
mkdir -p scripts
mkdir -p .logs
mkdir -p .claude/commands
echo "✓ Created: connectors/, data/, projects/, scripts/, .logs/, .claude/commands/"

# 3. Copy framework code
echo -e "${BLUE}🔧 Copying framework code...${NC}"

# Copy tools
rsync -av --exclude 'node_modules' --exclude '.DS_Store' \
  "$FRAMEWORK_DIR/tools/" "$INSTANCE_DIR/tools/"
echo "✓ Synced: tools/"

# Copy app
rsync -av \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.DS_Store' \
  --exclude 'src/components/tools/' \
  --exclude 'src/components/crm/' \
  "$FRAMEWORK_DIR/app/" "$INSTANCE_DIR/app/"
echo "✓ Synced: app/"

# Copy scripts
rsync -av \
  --exclude '.DS_Store' \
  "$FRAMEWORK_DIR/scripts/" "$INSTANCE_DIR/scripts/"
echo "✓ Synced: scripts/"

# Copy connector base classes
mkdir -p "$INSTANCE_DIR/connectors"
cp "$FRAMEWORK_DIR/connectors/MCPAdapter.js" "$INSTANCE_DIR/connectors/" 2>/dev/null || true
cp "$FRAMEWORK_DIR/connectors/APIClient.js" "$INSTANCE_DIR/connectors/" 2>/dev/null || true
echo "✓ Synced: connectors base classes"

# Copy framework tests
rsync -av \
  --exclude '.DS_Store' \
  "$FRAMEWORK_DIR/test/" "$INSTANCE_DIR/test/"
echo "✓ Synced: test/"

# Copy .claude/commands
rsync -av \
  --exclude '.DS_Store' \
  "$FRAMEWORK_DIR/.claude/commands/" "$INSTANCE_DIR/.claude/commands/"
echo "✓ Synced: .claude/commands/"

# 4. Create visualizations.json
echo -e "${BLUE}📊 Initializing visualizations registry...${NC}"
mkdir -p viz
cat > viz/visualizations.json <<EOF
{
  "visualizations": [],
  "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "totalVisualizations": 0,
  "totalViews": 0,
  "version": "1.0"
}
EOF
echo "✓ Created: viz/visualizations.json"

# Copy generic viz templates
for f in "$FRAMEWORK_DIR"/viz/*.html; do
  [ -e "$f" ] || continue
  basename=$(basename "$f")
  case "$basename" in company-profile-*|five-elms-*|sales-pipeline*) continue ;; esac
  cp "$f" "$INSTANCE_DIR/viz/"
done
echo "✓ Synced: viz templates"

# 5. Copy package.json from framework
echo -e "${BLUE}📦 Setting up package.json...${NC}"
if [ -f "$FRAMEWORK_DIR/package.json" ]; then
  cp "$FRAMEWORK_DIR/package.json" "$INSTANCE_DIR/package.json"
  # Update name field
  sed -i.bak "s/\"name\": \"localbase\"/\"name\": \"localbase-$INSTANCE_NAME\"/" package.json
  rm package.json.bak
  echo "✓ Created: package.json"
fi

# 6. Note about sync script
echo -e "${BLUE}🔄 Sync script ready...${NC}"
echo "✓ scripts/sync-framework.sh copied from framework"

# 8. Create env.local template
echo -e "${BLUE}🔐 Creating env.local template...${NC}"
cat > env.local <<EOF
# LocalBase Instance: $INSTANCE_NAME
# Environment Configuration

# Add your API keys and credentials here
# Example:
# HUBSPOT_API_KEY=your_key_here
# QUICKBOOKS_CLIENT_ID=your_client_id
# QUICKBOOKS_CLIENT_SECRET=your_secret
EOF
echo "✓ Created: env.local (template)"

# 9. Create .gitignore
echo -e "${BLUE}📝 Creating .gitignore...${NC}"
cat > .gitignore <<EOF
# Dependencies
node_modules/
package-lock.json

# Environment
env.local
.env

# Private banned-terms list (real instance/business names — never commit).
# Instances inherit this file from the framework; it must never enter git.
scripts/lib/banned-terms.local.sh

# Data — runtime state, wholesale.
# NB: this was previously "data/*.db", which only matches the top level and let
# nested databases like data/<connector>/<name>.db get committed by the initial
# "git add ." below.
data/

# Instance project work — default-private per the framework convention.
# Remove this line if a given instance deliberately tracks its projects.
projects/

# Logs
.logs/
*.log

# Build outputs
app/dist/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

# Temporary files
tmp/
*.tmp
EOF
echo "✓ Created: .gitignore"

# 10. Create example connector
echo -e "${BLUE}🔌 Creating example connector...${NC}"
mkdir -p connectors/example
cat > connectors/example/README.md <<EOF
# Example Connector

This is a template for creating new connectors in your LocalBase instance.

## Structure
- \`config.json\` - Connector metadata and configuration
- \`sync.js\` - Data sync script
- \`connector.js\` - MCP tools implementation (optional)

## Getting Started
1. Copy this directory to create a new connector
2. Update config.json with your connector details
3. Implement sync.js to fetch and store data
4. (Optional) Add MCP tools in connector.js for Claude integration
EOF
echo "✓ Created: connectors/example/"

# 11. Create CLAUDE.md
echo -e "${BLUE}📚 Creating CLAUDE.md...${NC}"
cat > CLAUDE.md <<EOF
# Claude Code Instructions - $INSTANCE_NAME

## Instance Overview
This is a LocalBase instance workspace for: **$INSTANCE_NAME**

## Key Directories
- \`connectors/\` - Data source connectors specific to this instance
- \`data/\` - Local SQLite databases
- \`tools/\`, \`app/\` - Framework code (synced from localbase.ai)
- \`env.local\` - API credentials and environment variables

## Workflow
1. Add connectors in \`connectors/\` directory
2. Store data in \`data/\` SQLite databases
3. Create visualizations in \`viz/\`
4. Pull framework updates: \`./scripts/sync-framework.sh\`

## Important
- Never commit \`env.local\` or \`data/\` to git
- Framework files are synced, not edited directly
- Instance-specific code stays in this repo

## Quick Start
\`\`\`bash
# Start dev server (installs deps automatically)
./scripts/start.sh

# Or use /start in Claude Code
\`\`\`
EOF
echo "✓ Created: CLAUDE.md"

# 12. Initial commit
echo -e "${BLUE}💾 Creating initial commit...${NC}"
git add .

# Guard: "git add ." above stages whatever .gitignore failed to catch, and the
# initial commit is the one nobody ever re-reads. Instances bootstrapped before
# 2026-08-15 shipped their real business names in commit one this way, because
# banned-terms.local.sh had no ignore rule and data/*.db missed nested dirs.
# Fail loudly rather than bake a secret into the first commit.
BOOTSTRAP_BLOCKED=0
while IFS= read -r staged; do
  case "$staged" in
    env.local|.env|*/env.local|*/.env|\
    scripts/lib/banned-terms.local.sh|\
    *.db|*.db-shm|*.db-wal|*.sqlite|*.sqlite3|*.sqlite-shm|*.sqlite-wal)
      echo -e "${RED}✖ refusing to commit: $staged${NC}" >&2
      BOOTSTRAP_BLOCKED=1
      ;;
  esac
done < <(git diff --cached --name-only)

if [ "$BOOTSTRAP_BLOCKED" -eq 1 ]; then
  echo "" >&2
  echo "The initial commit was blocked because .gitignore did not cover the" >&2
  echo "files above. Add rules for them, then re-run:" >&2
  echo "    git reset && git add . && git commit" >&2
  exit 1
fi

git commit -m "Initial commit: Bootstrap LocalBase instance '$INSTANCE_NAME'

Created by bootstrap-instance.sh from localbase.ai framework

Instance structure:
- Framework code: tools/, app/, scripts/
- Instance-specific: connectors/, data/, env.local

🤖 Generated with LocalBase Framework"

echo ""
echo -e "${GREEN}✅ Instance '$INSTANCE_NAME' created successfully!${NC}"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo "1. cd $INSTANCE_DIR"
echo "2. Edit env.local with your API credentials"
echo "3. ./scripts/start.sh (installs deps and starts servers)"
echo ""
echo -e "${BLUE}🔄 Future framework updates:${NC}"
echo "   ./scripts/sync-framework.sh"
echo ""
