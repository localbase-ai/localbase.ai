#!/bin/bash
# LocalBase Production Build Script

set -e  # Exit on error

echo "🧹 Cleaning previous build..."
rm -rf dist

echo "🔨 Building production app..."
npm run electron:build

echo ""
echo "✅ Build complete!"
echo ""
echo "📦 App locations:"
echo "   Unpacked: dist/electron/mac-arm64/LocalBase.app"
echo "   DMG:      dist/electron/LocalBase-1.0.0-arm64.dmg"
echo ""
echo "🚀 Opening app..."
open dist/electron/mac-arm64/LocalBase.app

echo ""
echo "💡 To install in Applications:"
echo "   1. Open: dist/electron/LocalBase-1.0.0-arm64.dmg"
echo "   2. Drag LocalBase to Applications folder"
