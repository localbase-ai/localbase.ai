#!/bin/bash
# Sync framework code from localbase.ai to this instance
# Run from INSTANCE directory: ./scripts/sync-framework.sh
#
# By convention: framework + all instances live under $LOCALBASE_ROOT
# (default ~/Localbase). Override LOCALBASE_ROOT to install elsewhere.

set -e

LOCALBASE_ROOT="${LOCALBASE_ROOT:-$HOME/Localbase}"
FRAMEWORK_DIR="$LOCALBASE_ROOT/localbase.ai"
INSTANCE_DIR=$(pwd)

if [ ! -d "$FRAMEWORK_DIR" ]; then
  echo "❌ Framework not found at: $FRAMEWORK_DIR"
  echo "   Set LOCALBASE_ROOT to your framework's parent directory and retry."
  exit 1
fi

echo "🔄 Syncing framework from localbase.ai..."
echo "   Source: $FRAMEWORK_DIR"
echo "   Target: $INSTANCE_DIR"
echo ""

# Sync app/ (Vite + React UI)
echo "📱 Syncing app/..."
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.DS_Store' \
  --exclude 'src/components/tools/' \
  --exclude 'src/components/crm/' \
  --exclude 'src/components/index/' \
  $FRAMEWORK_DIR/app/ $INSTANCE_DIR/app/

# Sync tools/ framework
echo "🔧 Syncing tools/..."
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  $FRAMEWORK_DIR/tools/ $INSTANCE_DIR/tools/

# Sync scripts/ — including sync-framework.sh itself so script fixes propagate.
# (The currently-running script's logic is unchanged mid-run; the new version
# takes effect on the *next* sync.)
echo "📜 Syncing scripts/..."
mkdir -p $INSTANCE_DIR/scripts
rsync -av \
  --exclude '.DS_Store' \
  $FRAMEWORK_DIR/scripts/ $INSTANCE_DIR/scripts/

# Sync .claude/commands/ (Claude Code slash commands)
echo "🤖 Syncing .claude/commands/..."
mkdir -p $INSTANCE_DIR/.claude/commands
rsync -av \
  --exclude '.DS_Store' \
  $FRAMEWORK_DIR/.claude/commands/ $INSTANCE_DIR/.claude/commands/

# Sync connector base classes (NOT business connectors)
echo "🔌 Syncing connector base classes..."
cp $FRAMEWORK_DIR/connectors/MCPAdapter.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
cp $FRAMEWORK_DIR/connectors/APIClient.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
cp $FRAMEWORK_DIR/connectors/SqliteConnector.js $INSTANCE_DIR/connectors/ 2>/dev/null || true

# Sync viz/ framework assets
# - JS/CSS are framework-level shared assets (e.g., viz-colors.js)
# - HTML files filtered to skip instance-specific viz patterns
echo "📊 Syncing viz/ assets..."
mkdir -p $INSTANCE_DIR/viz
for f in $FRAMEWORK_DIR/viz/*.js $FRAMEWORK_DIR/viz/*.css; do
  [ -e "$f" ] || continue
  cp "$f" $INSTANCE_DIR/viz/
done
for f in $FRAMEWORK_DIR/viz/*.html; do
  [ -e "$f" ] || continue
  basename=$(basename "$f")
  case "$basename" in company-profile-*|five-elms-*|sales-pipeline*) continue ;; esac
  cp "$f" $INSTANCE_DIR/viz/
done

# Sync shared test suite. Uses a manifest to remove framework tests that the
# framework deleted (rsync alone can't, since `--delete` would also nuke
# instance-specific tests living alongside framework ones).
echo "🧪 Syncing test/..."
mkdir -p $INSTANCE_DIR/test
MANIFEST="$INSTANCE_DIR/test/.framework-tests"
NEW_MANIFEST=$(mktemp)
(cd "$FRAMEWORK_DIR/test" && find . -maxdepth 1 -type f \( -name "*.test.js" -o -name "*.md" \) -exec basename {} \; | sort) > "$NEW_MANIFEST"

if [ -f "$MANIFEST" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    target="$INSTANCE_DIR/test/$f"
    if [ -f "$target" ]; then
      echo "   🧹 Removing test/$f (no longer in framework)"
      /bin/rm "$target"
    fi
  done < <(comm -23 "$MANIFEST" "$NEW_MANIFEST")
fi

rsync -av \
  --exclude '.DS_Store' \
  --exclude '.framework-tests' \
  $FRAMEWORK_DIR/test/ $INSTANCE_DIR/test/

mv "$NEW_MANIFEST" "$MANIFEST"

# Clean up old directories that no longer exist in framework
for OLD_DIR in electron-app web-app tools/connectors; do
  if [ -d "$INSTANCE_DIR/$OLD_DIR" ]; then
    echo "🧹 Removing deprecated $OLD_DIR..."
    rm -rf "$INSTANCE_DIR/$OLD_DIR"
  fi
done

# Ensure framework's deps are installed in the instance.
# Instance package.json is its own — we don't overwrite it — but any
# framework dep (esp. test-suite deps like light-my-request) the instance
# doesn't already declare needs to be added.
echo ""
echo "📦 Ensuring framework deps are installed..."
for PKG_DIR in "." "app"; do
  FRAMEWORK_PKG="$FRAMEWORK_DIR/$PKG_DIR/package.json"
  INSTANCE_PKG_DIR="$INSTANCE_DIR/$PKG_DIR"
  [ -f "$FRAMEWORK_PKG" ] && [ -f "$INSTANCE_PKG_DIR/package.json" ] || continue

  missing_prod=$(node -e "
    try {
      const fw = require('$FRAMEWORK_PKG');
      const ins = require('$INSTANCE_PKG_DIR/package.json');
      const have = Object.assign({}, ins.dependencies||{}, ins.devDependencies||{});
      console.log(Object.keys(fw.dependencies||{}).filter(d => !have[d]).join(' '));
    } catch (e) { console.log(''); }
  ")
  missing_dev=$(node -e "
    try {
      const fw = require('$FRAMEWORK_PKG');
      const ins = require('$INSTANCE_PKG_DIR/package.json');
      const have = Object.assign({}, ins.dependencies||{}, ins.devDependencies||{});
      console.log(Object.keys(fw.devDependencies||{}).filter(d => !have[d]).join(' '));
    } catch (e) { console.log(''); }
  ")

  if [ -n "$missing_prod" ]; then
    echo "   📥 Adding $PKG_DIR deps: $missing_prod"
    (cd "$INSTANCE_PKG_DIR" && npm install --save --no-audit --no-fund $missing_prod)
  fi
  if [ -n "$missing_dev" ]; then
    echo "   📥 Adding $PKG_DIR devDeps: $missing_dev"
    (cd "$INSTANCE_PKG_DIR" && npm install --save-dev --no-audit --no-fund $missing_dev)
  fi
  if [ -z "$missing_prod" ] && [ -z "$missing_dev" ]; then
    echo "   ✓ $PKG_DIR has all framework deps"
  fi
done

# Refresh installs if instance package.json is newer than node_modules
# (e.g. user just added a dep). The framework-deps step above already handles
# missing framework deps; this catches user-driven changes.
for PKG_DIR in "." "app"; do
  PKG_PATH="$INSTANCE_DIR/$PKG_DIR/package.json"
  [ -f "$PKG_PATH" ] || continue
  if [ ! -d "$INSTANCE_DIR/$PKG_DIR/node_modules" ] || [ "$PKG_PATH" -nt "$INSTANCE_DIR/$PKG_DIR/node_modules" ]; then
    echo "   📥 Refreshing $PKG_DIR install..."
    (cd "$INSTANCE_DIR/$PKG_DIR" && npm install --no-audit --no-fund)
  fi
done

# Run framework test suite to verify the sync didn't break anything (non-fatal)
echo ""
echo "🧪 Running framework tests..."
TEST_OUTPUT=$(cd "$INSTANCE_DIR" && npm test --silent 2>&1) && TEST_OK=1 || TEST_OK=0
if [ "$TEST_OK" = "1" ]; then
  echo "   ✓ all tests passed"
else
  echo "   ⚠️  some tests failed — review before committing:"
  echo "$TEST_OUTPUT" | tail -20 | sed 's/^/      /'
fi

echo ""
echo "✅ Framework sync complete!"
echo ""
echo "🚨 INSTANCE-SPECIFIC (never synced from framework):"
echo "   - CLAUDE.md"
echo "   - connectors/*/ (business connectors)"
echo "   - projects/"
echo "   - data/"
echo "   - env.local"
echo "   - app/src/components/tools/ (instance components)"
echo "   - app/src/components/crm/ (instance components)"
echo "   - app/src/components/index/ (localbase-index components)"
echo ""
echo "📋 Next: git status to review changes"
