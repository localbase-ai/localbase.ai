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
#   LOCALBASE_VERSION  tag or branch to install (default: newest v* release
#                      tag, or main if there are no releases yet)

set -euo pipefail

LOCALBASE_ROOT="${LOCALBASE_ROOT:-$HOME/Localbase}"
REPO_URL="${LOCALBASE_REPO:-https://github.com/localbase-ai/localbase.ai}"
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

# Install a release, not whatever is on main this minute. Newest v* tag wins.
# Runs after the git check, and tolerates ls-remote failing (offline, no
# releases yet) instead of letting set -o pipefail end the script silently.
LATEST_TAG="$( { git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null || true; } | sed -n '1s#.*refs/tags/##p' )"
REF="${LOCALBASE_VERSION:-${LOCALBASE_BRANCH:-${LATEST_TAG:-main}}}"

# ── Framework: clone or update ───────────────────────────────────────────────
mkdir -p "$LOCALBASE_ROOT"
if [ -d "$FRAMEWORK_DIR/.git" ]; then
  say "${GREEN}✓${NC} framework already at $FRAMEWORK_DIR ${DIM}(updating to $REF)${NC}"
  update_framework() {
    git -C "$FRAMEWORK_DIR" fetch --quiet --tags origin || return 1
    git -C "$FRAMEWORK_DIR" -c advice.detachedHead=false checkout --quiet "$REF" || return 1
    # A tag checks out detached and is already exact; a branch needs a pull.
    if git -C "$FRAMEWORK_DIR" symbolic-ref -q HEAD >/dev/null; then
      git -C "$FRAMEWORK_DIR" pull --quiet --ff-only origin "$REF" || return 1
    fi
  }
  update_framework 2>/dev/null \
    || say "  ${DIM}update skipped (local changes or diverged history) — continuing with what's there${NC}"
else
  say "… cloning framework $REF to $FRAMEWORK_DIR"
  git -c advice.detachedHead=false clone --quiet --branch "$REF" "$REPO_URL" "$FRAMEWORK_DIR"
fi

# ── Dependencies ─────────────────────────────────────────────────────────────
say "… installing dependencies ${DIM}(a minute or two on first install)${NC}"
# npm ci installs exactly what package-lock.json pins (and verifies each
# package's hash), so every install of a release gets the same dependencies.
for pkg in "" "app"; do
  if [ -f "$FRAMEWORK_DIR/$pkg/package-lock.json" ]; then
    npm ci --prefix "$FRAMEWORK_DIR/$pkg" --no-audit --no-fund --loglevel=error
  else
    npm install --prefix "$FRAMEWORK_DIR/$pkg" --no-audit --no-fund --loglevel=error
  fi
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
