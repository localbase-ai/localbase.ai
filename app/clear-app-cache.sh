#!/bin/bash
# Clear macOS app caches for LocalBase
# Run this after updating the app to force Spotlight/Dock to refresh

set -e

APP_NAME="LocalBase"

echo "🧹 Clearing macOS caches for $APP_NAME..."
echo ""

# 1. Re-register the app with Launch Services
echo "📱 Re-registering app with Launch Services..."
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -r -domain local -domain system -domain user /Applications

# 2. Touch the app to trigger Spotlight reindex
if [ -d "/Applications/$APP_NAME.app" ]; then
  echo "🔄 Updating app timestamp..."
  touch "/Applications/$APP_NAME.app"
fi

# 3. Kill and restart Dock
echo "🔄 Restarting Dock..."
killall Dock

# 4. Clear app-specific caches (optional but thorough)
if [ -d "$HOME/Library/Application Support/$APP_NAME" ]; then
  echo "🗑️  Clearing app cache directories..."
  rm -rf "$HOME/Library/Application Support/$APP_NAME/Cache" 2>/dev/null || true
  rm -rf "$HOME/Library/Application Support/$APP_NAME/GPUCache" 2>/dev/null || true
fi

echo ""
echo "✅ Cache cleared!"
echo ""
echo "💡 Tips:"
echo "   - Wait a few seconds for Dock to restart"
echo "   - Search for '$APP_NAME' in Spotlight (Cmd+Space)"
echo "   - If still cached, reboot (nuclear option)"
echo ""
