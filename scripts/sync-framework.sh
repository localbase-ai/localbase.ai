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
#
# tools/cli/ is excluded: the `localbase` CLI lives there on disk but is
# gitignored (removed from the repo 2026-08-29, kept locally). rsync reads the
# filesystem, not git, so without this every sync copied it into each instance.
echo "🔧 Syncing tools/..."
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  --exclude 'cli/' \
  $FRAMEWORK_DIR/tools/ $INSTANCE_DIR/tools/

# Sync scripts/ — including sync-framework.sh itself so script fixes propagate.
# (The currently-running script's logic is unchanged mid-run; the new version
# takes effect on the *next* sync.)
#
# banned-terms.local.sh is excluded on purpose: it is gitignored, per-machine,
# and the one place an instance can tune its own scan (extra terms, or
# BANNED_TERMS_FILE_EXCLUDE_EXTRA for vendor data a broad term unavoidably
# matches). Copying the framework's over it silently discarded that tuning on
# every sync. The .example beside it still syncs, so the documentation travels.
echo "📜 Syncing scripts/..."
mkdir -p $INSTANCE_DIR/scripts
rsync -av \
  --exclude '.DS_Store' \
  --exclude 'lib/banned-terms.local.sh' \
  $FRAMEWORK_DIR/scripts/ $INSTANCE_DIR/scripts/

# Sync .claude/commands/ (Claude Code slash commands)
echo "🤖 Syncing .claude/commands/..."
mkdir -p $INSTANCE_DIR/.claude/commands
rsync -av \
  --exclude '.DS_Store' \
  $FRAMEWORK_DIR/.claude/commands/ $INSTANCE_DIR/.claude/commands/

# Push guard: refuses pushes to non-private GitHub repos, non-fast-forwards
# and unrelated history (scripts/hooks/pre-push). Never replaces a hook that's
# already there.
HOOK_PATH="$(git -C "$INSTANCE_DIR" rev-parse --git-path hooks 2>/dev/null)/pre-push"
if [ -d "$INSTANCE_DIR/.git" ] && [ -f "$FRAMEWORK_DIR/scripts/hooks/pre-push" ]; then
  case "$HOOK_PATH" in /*) ;; *) HOOK_PATH="$INSTANCE_DIR/$HOOK_PATH" ;; esac
  if [ ! -e "$HOOK_PATH" ]; then
    mkdir -p "$(dirname "$HOOK_PATH")"
    cp "$FRAMEWORK_DIR/scripts/hooks/pre-push" "$HOOK_PATH" && chmod +x "$HOOK_PATH"
    echo "🔒 Installed the pre-push guard"
  fi
fi

# Sync connector base classes (NOT business connectors)
echo "🔌 Syncing connector base classes..."
cp $FRAMEWORK_DIR/connectors/MCPAdapter.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
cp $FRAMEWORK_DIR/connectors/APIClient.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
cp $FRAMEWORK_DIR/connectors/SqliteConnector.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
# Shared Google OAuth, used by every Google connector
cp $FRAMEWORK_DIR/connectors/google-oauth.js $INSTANCE_DIR/connectors/ 2>/dev/null || true
cp $FRAMEWORK_DIR/connectors/google-authorize.js $INSTANCE_DIR/connectors/ 2>/dev/null || true

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

# A framework connector's test (test/<connector>.test.js) only belongs in an
# instance that has that connector, unmodified: connectors are installed per
# instance and aren't synced, and an instance's own connector of the same name
# is a different implementation the framework test would fail against.
CONNECTOR_TEST_EXCLUDES=()
for CONNECTOR in "$FRAMEWORK_DIR"/connectors/*/; do
  NAME=$(basename "$CONNECTOR")
  [ -f "$FRAMEWORK_DIR/test/$NAME.test.js" ] || continue
  if [ -d "$INSTANCE_DIR/connectors/$NAME" ] && diff -rq "$CONNECTOR" "$INSTANCE_DIR/connectors/$NAME" > /dev/null 2>&1; then
    continue
  fi
  CONNECTOR_TEST_EXCLUDES+=(--exclude "$NAME.test.js")
  # Remove a copy an earlier sync left behind, but never an instance's own test.
  if [ -f "$INSTANCE_DIR/test/$NAME.test.js" ] && cmp -s "$FRAMEWORK_DIR/test/$NAME.test.js" "$INSTANCE_DIR/test/$NAME.test.js"; then
    echo "   🧹 Removing test/$NAME.test.js (connector not installed from the framework)"
    /bin/rm "$INSTANCE_DIR/test/$NAME.test.js"
  fi
done

rsync -av \
  --exclude '.DS_Store' \
  --exclude '.framework-tests' \
  "${CONNECTOR_TEST_EXCLUDES[@]}" \
  $FRAMEWORK_DIR/test/ $INSTANCE_DIR/test/

mv "$NEW_MANIFEST" "$MANIFEST"

# Clean up old directories that no longer exist in framework
for OLD_DIR in electron-app web-app tools/connectors; do
  if [ -d "$INSTANCE_DIR/$OLD_DIR" ]; then
    echo "🧹 Removing deprecated $OLD_DIR..."
    rm -rf "$INSTANCE_DIR/$OLD_DIR"
  fi
done

# Keep the instance's package.json in step with the framework's.
# Instance package.json is its own: its extra packages are left alone. But
# every framework package is added if missing and raised to the framework's
# version when the instance asks for an older one, and the framework's
# security pins (overrides) are copied in, framework value winning. Without
# this, instances kept whatever versions they were created with and never
# picked up the framework's dependency fixes. The refresh step below then
# reinstalls, because package.json is newer than node_modules.
echo ""
echo "📦 Aligning framework dependencies..."
for PKG_DIR in "." "app"; do
  FRAMEWORK_PKG="$FRAMEWORK_DIR/$PKG_DIR/package.json"
  INSTANCE_PKG="$INSTANCE_DIR/$PKG_DIR/package.json"
  [ -f "$FRAMEWORK_PKG" ] && [ -f "$INSTANCE_PKG" ] || continue
  FRAMEWORK_PKG="$FRAMEWORK_PKG" INSTANCE_PKG="$INSTANCE_PKG" PKG_DIR="$PKG_DIR" node -e '
    const fs = require("fs");
    const fw = JSON.parse(fs.readFileSync(process.env.FRAMEWORK_PKG, "utf8"));
    const raw = fs.readFileSync(process.env.INSTANCE_PKG, "utf8");
    const ins = JSON.parse(raw);
    // Lowest version a "^1.2.3" / "~1.2.3" / "1.2.3" range allows; null for
    // anything else (tags, URLs, git), which is left untouched.
    const floor = (spec) => {
      const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(String(spec).trim());
      return m ? m.slice(1).map(Number) : null;
    };
    const older = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
    const changes = [];
    for (const section of ["dependencies", "devDependencies"]) {
      for (const [name, spec] of Object.entries(fw[section] || {})) {
        const current = (ins.dependencies || {})[name] ?? (ins.devDependencies || {})[name];
        const where = (ins.dependencies || {})[name] !== undefined ? "dependencies"
          : (ins.devDependencies || {})[name] !== undefined ? "devDependencies" : section;
        if (current === undefined) {
          (ins[where] ||= {})[name] = spec; changes.push(`+${name}@${spec}`);
        } else {
          const have = floor(current), want = floor(spec);
          if (have && want && older(have, want)) { ins[where][name] = spec; changes.push(`${name} ${current} -> ${spec}`); }
        }
      }
    }
    // Pins only ever raise a version: an instance pinned newer keeps its own.
    // npm refuses an override for a package the instance depends on directly,
    // so for those the dependency itself is raised instead.
    for (const [name, spec] of Object.entries(fw.overrides || {})) {
      const directIn = ["dependencies", "devDependencies"].find((sec) => (ins[sec] || {})[name] !== undefined);
      if (directIn) {
        const have = floor(ins[directIn][name]), want = floor(spec);
        if (have && want && older(have, want)) {
          const range = /^[\^~]/.test(spec) ? spec : `^${spec}`;
          changes.push(`${name} ${ins[directIn][name]} -> ${range}`);
          ins[directIn][name] = range;
        }
        continue;
      }
      const current = (ins.overrides || {})[name];
      const have = current === undefined ? null : floor(current), want = floor(spec);
      if (current === undefined || (have && want && older(have, want))) {
        (ins.overrides ||= {})[name] = spec; changes.push(`override ${name}@${spec}`);
      }
    }
    if (changes.length) {
      fs.writeFileSync(process.env.INSTANCE_PKG, JSON.stringify(ins, null, 2) + "\n");
      console.log(`   📥 ${process.env.PKG_DIR}: ${changes.join(", ")}`);
    } else {
      console.log(`   ✓ ${process.env.PKG_DIR} matches the framework`);
    }
  '
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
