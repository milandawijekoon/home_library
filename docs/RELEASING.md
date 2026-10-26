# Releasing and updating Shelfie Home Library

Installed apps check `build.publish.url` (in `package.json`) on launch and every 4 hours,
download new versions in the background and offer a restart. Customers' books live in
`~/Library/Application Support/HomeLibrary` (macOS) / `%APPDATA%\HomeLibrary` (Windows) and are never touched.

## One-time setup
1. Pick a host (Cloudflare R2, S3, or any static HTTPS host) and set `build.publish.url` to its folder URL.
   Do this **before the first public release**: apps already installed keep the URL they shipped with.
2. macOS: auto-update only works for **signed and notarized** apps (Apple Developer ID). Unsigned Mac builds
   download the update but macOS refuses to install it.
3. Windows: updates install unsigned, but SmartScreen warns until the installer is code-signed.

## Normal release
1. Bump `version` in `package.json` (never reuse a version number).
2. `npm test && npm run dist:mac:dmg && npm run dist:win`
3. Upload everything in `dist/electron/` except `mac/`, `mac-arm64/`, `win-unpacked/` and `builder-debug.yml`
   to the update URL: the installers, the `.zip` files (macOS updates use the zip), the `.blockmap` files
   and `latest.yml` / `latest-mac.yml`. Upload the manifests **last**: they are what switches clients over.

## Critical update
Release as above, then publish `app-config.json` next to the manifests:

    { "minimumVersion": "1.0.3", "message": "Security fix. Your books are not affected.",
      "downloadUrl": "https://example.com/download" }

Apps older than `minimumVersion` check every 30 minutes and, once the update is downloaded, show a
Restart-and-update prompt with no "Later" button. If no update can be fetched, they show a blocking
"update required" prompt that opens `downloadUrl` and then quits. Remove the file (or lower the number) to undo.

## Testing updates locally
Serve a folder holding a newer build's files and `app-config.json`, then run an older build with
`SHELFIE_UPDATE_URL=http://127.0.0.1:8099`. The app writes `updater.log` into its data folder.
