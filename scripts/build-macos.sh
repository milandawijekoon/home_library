#!/bin/sh
# Build "Home Library.app" (with its own Node runtime) and package it as a .dmg.
# Output: dist/macos/HomeLibrary-<version>-<arch>.dmg
# The app is ad-hoc signed. Without an Apple Developer ID, other Macs show a one-time
# "unidentified developer" prompt (right-click > Open). See docs/ for the customer steps.
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
VERSION="$(node -p "require('$SRC/package.json').version")"
ARCH="$(uname -m)"
OUT="$SRC/dist/macos"
APP="$OUT/Home Library.app"
DMG="$OUT/HomeLibrary-$VERSION-$ARCH.dmg"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app/node_modules/@zxing/library/umd" "$APP/Contents/Resources/runtime"

# --- application files (no tests, scripts, data or dev tooling)
for f in server.js store.js validate.js open-library.js launcher.js package.json; do
  cp "$SRC/$f" "$APP/Contents/Resources/app/"
done
cp -R "$SRC/public" "$APP/Contents/Resources/app/public"
cp "$SRC/node_modules/@zxing/library/umd/index.min.js" "$APP/Contents/Resources/app/node_modules/@zxing/library/umd/"
cp "$SRC/node_modules/@zxing/library/LICENSE" "$APP/Contents/Resources/app/node_modules/@zxing/library/"

# --- bundled Node runtime, so customers install nothing
cp "$NODE_BIN" "$APP/Contents/Resources/runtime/node"

# --- executable the Finder runs
cat > "$APP/Contents/MacOS/HomeLibrary" <<'LAUNCH_EOF'
#!/bin/sh
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG="$HOME/Library/Logs/HomeLibrary.log"
mkdir -p "$HOME/Library/Logs"
exec "$RES/runtime/node" "$RES/app/launcher.js" >>"$LOG" 2>&1
LAUNCH_EOF
chmod +x "$APP/Contents/MacOS/HomeLibrary"

# --- icon (skipped if it cannot be generated)
if [ -f "$SRC/scripts/AppIcon.svg" ]; then
  ICONSET="$OUT/AppIcon.iconset"
  mkdir -p "$ICONSET"
  if sips -s format png -z 1024 1024 "$SRC/scripts/AppIcon.svg" --out "$OUT/icon-1024.png" >/dev/null 2>&1; then
    for s in 16 32 128 256 512; do
      sips -z $s $s "$OUT/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s * 2)) $((s * 2)) "$OUT/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  else
    echo "warning: could not render AppIcon.svg, building without an icon" >&2
  fi
  rm -rf "$ICONSET" "$OUT/icon-1024.png"
fi

# --- Info.plist (LSUIElement: no Dock icon; the browser tab is the window)
cat > "$APP/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Home Library</string>
  <key>CFBundleDisplayName</key><string>Home Library</string>
  <key>CFBundleIdentifier</key><string>app.homelibrary.desktop</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>HomeLibrary</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST_EOF

codesign --force --deep --sign - "$APP"

# --- disk image: the app plus an Applications shortcut to drag onto
STAGE="$OUT/dmg-stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Home Library" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "Built: $DMG ($(du -h "$DMG" | cut -f1))"
