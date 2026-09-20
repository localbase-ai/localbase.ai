#!/bin/bash
# LocalBase installer
#
#   curl -fsSL https://raw.githubusercontent.com/localbase-ai/localbase.ai/main/scripts/install.sh | bash
#
# Clones the framework and installs its dependencies. Workspace creation is NOT
# done here — start the server with scripts/start.sh and pick a workspace in the
# UI.
#
# No interactive prompts: under `curl | bash` stdin is the script, not a
# keyboard.
#
# Overrides (mostly for testing):
#   LOCALBASE_ROOT     install root   (default ~/Localbase)
#   LOCALBASE_REPO     clone source   (default GitHub)
#   LOCALBASE_BRANCH   branch to install (default main)

set -euo pipefail

LOCALBASE_ROOT="${LOCALBASE_ROOT:-$HOME/Localbase}"
REPO_URL="${LOCALBASE_REPO:-https://github.com/localbase-ai/localbase.ai}"
BRANCH="${LOCALBASE_BRANCH:-main}"
FRAMEWORK_DIR="$LOCALBASE_ROOT/localbase.ai"

GREEN='\033[0;32m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

say()  { printf '%b\n' "$*"; }
fail() { printf '✗ %b\n' "$*" >&2; exit 1; }

say ""
say "  ${BOLD}LocalBase installer${NC}"
say ""

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 \
  || fail "git is required.\n  macOS: xcode-select --install\n  Linux: sudo apt install git"
command -v node >/dev/null 2>&1 \
  || fail "Node.js 18+ is required.\n  https://nodejs.org  ·  macOS: brew install node  ·  Linux: sudo apt install nodejs npm"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 18 ] \
  || fail "Node.js 18+ is required (you have $(node -v))."
say "${GREEN}✓${NC} git + node $(node -v)"

# ── Framework: clone or update ───────────────────────────────────────────────
mkdir -p "$LOCALBASE_ROOT"
if [ -d "$FRAMEWORK_DIR/.git" ]; then
  say "${GREEN}✓${NC} framework already at $FRAMEWORK_DIR ${DIM}(updating)${NC}"
  git -C "$FRAMEWORK_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null \
    || say "  ${DIM}pull skipped (local changes or diverged history) — continuing with what's there${NC}"
else
  say "… cloning framework to $FRAMEWORK_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$FRAMEWORK_DIR"
fi

# ── Dependencies ─────────────────────────────────────────────────────────────
say "… installing dependencies ${DIM}(a minute or two on first install)${NC}"
for pkg in "" "app"; do
  npm install --prefix "$FRAMEWORK_DIR/$pkg" --no-audit --no-fund --loglevel=error
done
say "${GREEN}✓${NC} dependencies installed"

# ── Done ─────────────────────────────────────────────────────────────────────
say ""
say "${GREEN}✓ LocalBase installed${NC}"
say ""
say "  Start it with:"
say ""
say "  ${BOLD}${GREEN}cd $FRAMEWORK_DIR && bash scripts/start.sh${NC}"
say ""
