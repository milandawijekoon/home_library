#!/bin/sh
# Build the Windows installer (HomeLibrary-Setup-<version>-x64.exe) from macOS or Linux.
# Needs: makensis (apt install nsis / choco install nsis), curl, shasum, unzip, zip, node.
# The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC" until it is
# signed with a code-signing certificate (More info > Run anyway).
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
NODE_VERSION="${WIN_NODE_VERSION:-24.13.0}"
CACHE="$SRC/.cache"
OUT="$SRC/dist/windows"
STAGE="$OUT/stage"
ZIP="node-v$NODE_VERSION-win-x64.zip"

mkdir -p "$CACHE"
if [ ! -f "$CACHE/$ZIP" ]; then
  curl -fsSL -o "$CACHE/$ZIP" "https://nodejs.org/dist/v$NODE_VERSION/$ZIP"
fi
EXPECTED="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $ZIP\$" | cut -d' ' -f1)"
ACTUAL="$(shasum -a 256 "$CACHE/$ZIP" | cut -d' ' -f1)"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "Checksum mismatch for $ZIP" >&2; rm -f "$CACHE/$ZIP"; exit 1; }

rm -rf "$OUT"
mkdir -p "$STAGE/app/node_modules/@zxing/library/umd"

# --- application files (same set as the macOS build)
for f in server.js store.js validate.js open-library.js launcher.js package.json; do
  cp "$SRC/$f" "$STAGE/app/"
done
cp -R "$SRC/public" "$STAGE/app/public"
cp "$SRC/node_modules/@zxing/library/umd/index.min.js" "$STAGE/app/node_modules/@zxing/library/umd/"
cp "$SRC/node_modules/@zxing/library/LICENSE" "$STAGE/app/node_modules/@zxing/library/"

# --- bundled Node runtime
unzip -q -j "$CACHE/$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" -d "$STAGE"
cp "$SRC/installer/HomeLibrary.vbs" "$STAGE/"

# --- icon: installer/AppIcon.ico is a 256px PNG of scripts/AppIcon.svg wrapped in an .ico container.
# Re-render it with: sips -s format png -z 256 256 scripts/AppIcon.svg --out icon.png (macOS), then wrap the PNG.
cp "$SRC/installer/AppIcon.ico" "$STAGE/AppIcon.ico"

# Portable zip: unzip anywhere and double-click HomeLibrary.vbs (no installer needed).
(cd "$STAGE" && zip -qr "$OUT/HomeLibrary-$VERSION-win-x64-portable.zip" .)

# Setup.exe. Some makensis builds crash on macOS; the portable zip above is still produced then,
# and the installer can be built on a Windows machine / CI runner instead.
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT/HomeLibrary-Setup-$VERSION-x64.exe" "$SRC/installer/windows.nsi" \
  || echo "warning: makensis failed, no Setup.exe built (portable zip is fine)" >&2

rm -rf "$STAGE"
echo "Built: $(ls "$OUT")"
