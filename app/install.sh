#!/bin/bash
# Install LocalBase to Applications folder

set -e

APP_NAME="LocalBase.app"
SOURCE="dist/electron/mac-arm64/$APP_NAME"
DEST="/Applications/$APP_NAME"

echo "📦 Installing LocalBase to Applications..."
echo ""

# Check if source exists
if [ ! -d "$SOURCE" ]; then
    echo "❌ Error: $SOURCE not found"
    echo "   Run 'npm run prod' first to build the app"
    exit 1
fi

# Remove old version if exists
if [ -d "$DEST" ]; then
    echo "🗑️  Removing old version from Applications..."
    rm -rf "$DEST"
fi

# Copy new version
echo "📥 Copying new version to Applications..."
cp -R "$SOURCE" "$DEST"

echo ""
echo "✅ Installation complete!"
echo "   LocalBase is now in /Applications"
echo ""

# Clear caches to ensure Spotlight picks up the new version
echo "🧹 Clearing app caches..."
./clear-app-cache.sh

echo "🚀 You can now:"
echo "   - Open from Spotlight (Cmd+Space, type 'LocalBase')"
echo "   - Find in Applications folder"
echo "   - Add to Dock"
