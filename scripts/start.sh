#!/bin/bash
# LocalBase startup script

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "🚀 Starting LocalBase..."
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Install from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${YELLOW}Warning: Node.js 18+ recommended (you have $(node -v))${NC}"
fi

# Install root dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Check if package-lock changed
if [ "package.json" -nt "node_modules/.package-lock.json" ] 2>/dev/null; then
    echo "📦 Updating dependencies..."
    npm install
fi

# Install app dependencies if needed
if [ ! -d "app/node_modules" ]; then
    echo "📦 Installing app dependencies..."
    (cd app && npm install)
fi

# Check if app package-lock changed
if [ "app/package.json" -nt "app/node_modules/.package-lock.json" ] 2>/dev/null; then
    echo "📦 Updating app dependencies..."
    (cd app && npm install)
fi

# Check if ports are available
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# Resolve through tools/ports.js rather than re-reading the env here, so the
# shell and the server can never disagree. Duplicating the fallback meant an
# out-of-range override (e.g. LOCALBASE_API_PORT=80) printed one port while the
# server bound another — and this script then offered to kill whatever held it.
PORTS=$(node -e "import('./tools/ports.js').then(m=>console.log(m.API_PORT,m.APP_PORT))" 2>/dev/null)
API_PORT=$(echo "$PORTS" | awk '{print $1}')
APP_PORT=$(echo "$PORTS" | awk '{print $2}')
if ! [[ "$API_PORT" =~ ^[0-9]+$ && "$APP_PORT" =~ ^[0-9]+$ ]]; then
    echo -e "${YELLOW}Could not read tools/ports.js — using defaults 9220/9221${NC}"
    API_PORT=9220
    APP_PORT=9221
fi

for port in "$API_PORT" "$APP_PORT"; do
    if ! check_port "$port"; then
        echo -e "${YELLOW}Warning: Port $port is in use${NC}"
        echo "Kill the process? (y/n)"
        read -r response
        if [ "$response" = "y" ]; then
            lsof -ti:"$port" | xargs kill -9 2>/dev/null || true
            echo "Killed process on port $port"
        fi
    fi
done

# Build knowledge index
echo "📚 Building knowledge index..."
node scripts/build-knowledge.js . 2>/dev/null || echo -e "${YELLOW}Warning: Knowledge index build skipped${NC}"

# Start the dev server
echo ""
echo -e "${GREEN}Starting dev server...${NC}"
echo "  API:  http://localhost:$API_PORT"
echo "  App:  http://localhost:$APP_PORT"
echo ""

# Open browser after a short delay
(sleep 2 && open "http://localhost:$APP_PORT" 2>/dev/null || xdg-open "http://localhost:$APP_PORT" 2>/dev/null || true) &

# Start dev server (this blocks)
npm run dev
