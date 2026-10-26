# Releasing and updating

Installers are hosted as assets on **GitHub Releases** (free for a public repo). Installed apps check
`build.publish.url` in `package.json` (`https://github.com/milandawijekoon/home_library/releases/latest/download`),
which GitHub redirects to the files of the newest published release, so no extra hosting or DNS is needed.
The optional critical-update file `release-config/app-config.json` is read straight from `main` on GitHub.
Customers' books live in `~/Library/Application Support/HomeLibrary` (macOS) / `%APPDATA%\HomeLibrary` (Windows)
and are never touched by an update.

Note: 1.0.0 and 1.1.0 shipped with a `downloads.milandawijekoon.com` address that was never set up, so those
two versions cannot find updates. Install 1.1.1 or newer once by hand; from then on updates are detected.

## Normal release
1. Bump `version` in `package.json` (semver, never reuse a number), commit, push.
2. `git tag v1.1.2 && git push origin v1.1.2`
3. The **Release** workflow builds macOS and Windows installers and creates a **draft** GitHub release.
4. Open the draft, test an installer, edit the notes, then **Publish**. Publishing makes every file and
   `latest*.yml` appear at once, so apps never see a half-uploaded release. Do not mark it as a pre-release
   (the `latest` link skips pre-releases).

## Critical update
Release as above, then edit `release-config/app-config.json` on `main`:

    { "minimumVersion": "1.0.3", "message": "Security fix. Your books are not affected.",
      "downloadUrl": "https://github.com/milandawijekoon/home_library/releases/latest" }

Apps older than `minimumVersion` check every 30 minutes and must update (a blocking prompt; no "Later").
GitHub caches the raw file for about 5 minutes. Set `minimumVersion` back to a lower number to undo.

## Unsigned builds (current MVP)
- **Windows** installs updates itself; SmartScreen warns on each new installer until it is signed.
- **macOS** only installs updates for apps signed with an Apple Developer ID. Until then the app detects that it
  is unsigned, tells the user a new version exists and opens the download page.
  Once signed, add the certificate as repository secrets and the same code installs updates automatically.

## Download page
`docs/download-page.html` reads `https://api.github.com/repos/milandawijekoon/home_library/releases/latest`
and builds the buttons, so the page never needs editing for a release. Unauthenticated API use is limited to
60 requests per hour per visitor IP, which is plenty.

## Testing updates locally
Serve a folder holding a newer build's files and `app-config.json`, then run an older build with
`SHELFIE_UPDATE_URL=http://127.0.0.1:8099`. The app writes `updater.log` into its data folder.
